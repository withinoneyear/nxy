import fs from "fs";
import http, { IncomingMessage, ServerResponse } from "http";
import https from "https";
import adapt from "ugly-adapter";
import pem from "pem";
import tls from "tls";
import net from "net";
import { Readable, Duplex } from "stream";
import { pipeline } from "stream";
import * as rules from "./rules";
import { OnRequest, IRuleHandler, RuleResponse, CacheRule } from "./rules";
import { Inspector, IInspector, IInspectorArgs } from "./inspector";

type SslCert = {
  key: string;
  cert: string;
};

enum ErrorType {
  HTTP,
  HTTPS,
  CONNECT,
  FORWARD,
}

type Rule = {
  name?: string;
  args?: any;
  match?: (req: IncomingMessage) => boolean;
  handler?: IRuleHandler;
};

type ProxyOptions = {
  port: number;
  sslCert?: SslCert;
  log?: (msg: any, ...params: any[]) => void;
  onError?: (type: ErrorType, error: any) => void;
  inspector?: IInspectorArgs | IInspector;
  cacheDir?: string;
  clearCacheOnStart?: boolean;
};

const genSNICallback = ({ key, cert }: { key: Buffer; cert: Buffer }) => (
  serverName: string,
  cb: any
) => {
  adapt
    .part(pem.createCertificate)({
      country: "AU",
      organization: "Json Pi",
      commonName: serverName,
      altNames: [serverName],
      serviceKey: key,
      serviceCertificate: cert,
      serial: Date.now(),
      days: 100,
    })
    .then((cr: any) => {
      const { clientKey: key, certificate: cert } = cr;
      const ctx = tls.createSecureContext({ key, cert });
      cb(null, ctx);
    });
};

function createMatcher(url: string | RegExp) {
  if (url instanceof RegExp) return url;
  const rUrl = url
    .replace(/^https?:\/\//i, ``)
    .split("*")
    .map((x) => JSON.stringify(x).slice(1, -1))
    .join(".*?");
  return new RegExp(rUrl);
}

type ErrorHandler = (e?: Error | null) => void;

class SimpleProxy {
  private options: ProxyOptions;
  private httpServer?: http.Server;
  private httpsServer?: https.Server;
  private rules: Rule[];
  inspector?: IInspector;

  constructor(options: ProxyOptions = { port: 8080 }) {
    this.options = options;
    this.rules = [];
    if (options.inspector) {
      if ("onRequest" in options.inspector)
        this.inspector = options.inspector as IInspector;
      else this.inspector = new Inspector(options.inspector as IInspectorArgs);
      this.options.log?.("Inspector dir: " + this.inspector?.dir);
    }
  }

  get httpAddress() {
    return this.httpServer?.address();
  }

  get httpsAddress() {
    return this.httpsServer?.address();
  }

  start() {
    this.startHttpsServer();
    this.startHttpServer();
  }

  stop() {
    this.httpServer?.close();
    this.httpsServer?.close();
  }

  delay(path: RegExp | string, latencyInMs: number, name = "delay") {
    this.addRule({
      path,
      args: { delay: latencyInMs },
      name,
      onRequest: rules.delay,
    });
  }

  content(path: RegExp | string, value: any, name = "content") {
    this.addRule({ path, args: value, name, onRequest: rules.content });
  }

  file(path: RegExp | string, filePath: string, name = "file") {
    this.addRule({ path, args: filePath, name, onRequest: rules.file });
  }

  forward(path: RegExp | string, url: string, name = "forward") {
    this.addRule({ path, args: url, name, onRequest: rules.forward });
  }

  private _cacheRule?: CacheRule;
  private get cacheRule() {
    if (!this._cacheRule) {
      this._cacheRule = new CacheRule(this.options.cacheDir);
      if (this.options.clearCacheOnStart === true) this._cacheRule.clear();
    }
    return this._cacheRule;
  }

  cache(
    path: RegExp | string,
    ttl?: number,
    cacheByQuery?: boolean,
    name = "cache"
  ) {
    this.addRule({
      name,
      path,
      args: { ttl, cacheByQuery },
      handler: this.cacheRule,
    });
  }

  clearCache() {
    this.cacheRule?.clear();
  }

  addRule(rule: {
    path: RegExp | string;
    args?: any;
    name?: string;
    onRequest?: OnRequest;
    onResponse?: rules.OnResponse;
    handler?: IRuleHandler;
  }) {
    this.rules.push({
      ...rule,
      match: (req) =>
        createMatcher(rule.path).test(`${req.headers.host}${req.url}`),
      handler: rule.handler || {
        onRequest: rule.onRequest,
        onResponse: rule.onResponse,
      },
    });
  }

  addCustomRule(rule: Rule) {
    this.rules.push(rule);
  }

  private startHttpsServer() {
    if (this.options.sslCert?.key) {
      const cert = {
        key: fs.readFileSync(this.options.sslCert!.key),
        cert: fs.readFileSync(this.options.sslCert!.cert),
      };
      this.httpsServer = https
        .createServer(
          { ...cert, SNICallback: genSNICallback(cert) },
          (req, res) => {
            this.forwardRequest(req, res, "https");
          }
        )
        .listen(0, "localhost");

      this.httpsServer.on("error", (err: any) => {
        this.options.onError?.(ErrorType.HTTPS, err);
      });
    }
  }

  private startHttpServer() {
    this.httpServer = http
      .createServer((req, res) => {
        this.forwardRequest(req, res, "http");
      })
      .listen(this.options.port, () => {
        this.options.log?.(`Listening http on ${this.options.port}...`);
      });

    // CONNECT method here is only for https
    // forward to httpsServer for https request
    this.httpServer.on("connect", this.onConnect);

    this.httpServer.on("error", (err: any) => {
      this.options.onError?.(ErrorType.HTTP, `httpServer error: ${err}`);
    });
  }

  private onConnect = (
    request: http.IncomingMessage,
    clientSocket: Duplex,
    head: Buffer
  ) => {
    const onConnctError = (err: any) =>
      this.options.onError?.(ErrorType.CONNECT, err);
    if (!this.httpsServer) {
      clientSocket.end("https proxy not enabled!");
      return;
    }
    const addr = this.httpsServer.address() as net.AddressInfo;
    const forwardSocket = net.connect(addr.port, addr.address, () => {
      try {
        clientSocket.write(`HTTP/1.1 200 Connection Established\r\n\r\n`);
        forwardSocket.write(head);
        pipeline(clientSocket, forwardSocket, clientSocket, (err: any) => {
          if (err && err.code !== "ECONNRESET" && err.code !== "EPIPE")
            onConnctError(err);
        });
      } catch (err) {
        onConnctError(err);
      }
    });
  };

  private seq = 0;
  private forwardRequest = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    protocol: string
  ) => {
    const url = new URL(req.url!, `${protocol}://${req.headers.host}`);
    const rule = this.rules.find((x) => x.match!(req));
    const handleError: ErrorHandler = (e: any) => {
      if (!e) return;
      res.destroy(e);
      this.options.onError?.(ErrorType.FORWARD, e);
    };

    const seq = ++this.seq;
    req.pause();
    this.inspector?.onRequest(seq, req, rule?.name);

    if (rule && req.method === "OPTIONS") {
      req.resume();
      res.writeHead(204, {
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "*",
        "Access-Control-Allow-Origin": "*",
      });
      res.end();
      return;
    }

    Promise.resolve(
      rule?.handler?.onRequest?.({ seq, req, args: rule?.args })
    ).then((rt) => {
      if (rt === false) return;
      if (rt == null || rt === true || rt instanceof URL) {
        const targetUrl = rt instanceof URL ? rt : url;
        this.fetch(seq, targetUrl, req, res, rule, handleError);
      } else {
        req.resume();
        const response =
          rt instanceof RuleResponse ? rt : { body: rt, statusCode: 200 };
        if (response.statusCode == null) response.statusCode = 200;
        if (rt instanceof Error) response.statusCode = 500;
        res.setHeader("Access-Control-Allow-Origin", "*");
        this.onResponse(seq, res, response as any, handleError);
      }
    });
  };

  private fetch(
    seq: number,
    url: URL,
    req: IncomingMessage,
    res: ServerResponse,
    rule: Rule | undefined,
    handleError: ErrorHandler
  ) {
    const request = url.protocol.startsWith("https")
      ? https.request.bind(https)
      : http.request.bind(http);
    const forwardReq = request(
      url as any,
      {
        method: req.method,
        headers: req.headers,
      },
      (response) => {
        rule?.handler?.onResponse?.({ seq, res: response });
        this.onResponse(seq, res, response, handleError);
      }
    );
    pipeline(req, forwardReq, (e) => {
      if (!e) return;
      handleError(e);
      forwardReq.destroy();
    });
    req.resume();
  }

  private onResponse = (
    seq: number,
    res: ServerResponse,
    response: RuleResponse,
    handleError: ErrorHandler
  ) => {
    try {
      res.writeHead(
        response.statusCode ?? 500,
        response.statusMessage ?? "",
        response.headers || {}
      );
      this.inspector?.onRespond(seq, response);
      let stream = response.body || response;
      if (stream instanceof Readable) {
        pipeline(stream, res, handleError);
      } else {
        res.end(response.body);
      }
    } catch (err) {
      handleError(err);
      this.inspector?.onRespond(seq, err);
    }
  };
}

export default SimpleProxy;
