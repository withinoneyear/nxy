import fs from "fs";
import path from "path";
import crypto from "crypto";
import http, { IncomingMessage } from "http";
import { Stream, Readable, PassThrough } from "stream";

export class RuleResponse {
  statusCode?: number;
  statusMessage?: string;
  headers?: { [key: string]: any };
  body?: string | Stream;
}
export type RuleResult =
  | Boolean
  | Error
  | URL
  | Stream
  | string
  | RuleResponse
  | void;

export type RequestArgs = {
  seq: number;
  req: http.IncomingMessage;
  args?: any;
};

export type ResponseArgs = {
  seq: number;
  res?: RuleResponse;
  args?: any;
};

export type OnRequest = (
  args: RequestArgs
) => Promise<RuleResult> | RuleResult | void;
export type OnResponse = (args: ResponseArgs) => RuleResult | void;

export interface IRuleHandler {
  onRequest?: OnRequest;
  onResponse?: OnResponse;
}

export const delay: OnRequest = ({ args }) => {
  if (args.delay <= 0) return;
  return new Promise((resolve) => setTimeout(() => resolve(), args.delay));
};

export const content: OnRequest = ({ args }) => {
  if (args && typeof args === "object") return JSON.stringify(args);
  return args?.toString();
};

export const file: OnRequest = ({ args: path }) => {
  if (!path || !fs.existsSync(path)) return { statusCode: 404 };
  try {
    return fs.createReadStream(path);
  } catch (err) {
    return err;
  }
};

export const forward: OnRequest = ({ req, args: url }) => {
  const uri = new URL(url);
  req.url = url
    .trim()
    .substring(`${uri.protocol}://${req.headers.host}`.length);
  req.headers.host = uri.host;
  return Promise.resolve(new URL(url));
};

export interface ICacheArgs {
  ttl: number;
  cacheByQuery: boolean;
}

export class CacheRule implements IRuleHandler {
  private static requests: any = {};
  private dir: string;
  constructor(dir?: string) {
    this.dir = dir || path.resolve(__dirname, ".cache");
    if (!fs.existsSync) fs.mkdirSync(this.dir);
  }

  clear() {
    if (fs.existsSync(this.dir)) fs.rmdirSync(this.dir, { recursive: true });
  }

  onRequest: OnRequest = ({ seq, req, args }) => {
    const { ttl, cacheByQuery = false } = args as ICacheArgs;
    const file = this.getCacheFile(req, cacheByQuery);
    if (file.exist) {
      const head = JSON.parse(
        fs.readFileSync(file.headFile, { encoding: "utf8" })
      );
      if (ttl == null || head.updateTime + ttl * 1000 >= Date.now()) {
        return Object.assign(new RuleResponse(), head, {
          body: fs.existsSync(file.bodyFile)
            ? fs.createReadStream(file.bodyFile)
            : "",
        });
      }
    }
    CacheRule.requests[seq] = { file, ttl };
  };

  onResponse: OnResponse = ({ seq, res }) => {
    const { file } = CacheRule.requests[seq];
    if (!file) return;
    if (!fs.existsSync(file.dir)) fs.mkdirSync(file.dir, { recursive: true });
    fs.writeFileSync(
      file.headFile,
      JSON.stringify({
        statusCode: res?.statusCode,
        statusMessage: res?.statusMessage,
        headers: res?.headers,
        updateTime: Date.now(),
      })
    );
    if (res instanceof Readable) {
      res.pipe(fs.createWriteStream(file.bodyFile));
    }
  };

  private getCacheFile(req: IncomingMessage, cacheByQuery: boolean) {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const dir = path.resolve(
      this.dir,
      `${url.host}${url.pathname}`.replace(":", "/")
    );
    const hash =
      cacheByQuery && url.search
        ? crypto.createHash("md5").update(url.search).digest("hex")
        : "";
    const name = hash ? [req.method, hash].join(".") : req.method;
    const headFile = path.resolve(dir, name || "1") + ".head";
    const bodyFile = path.resolve(dir, name || "1") + ".body";
    return {
      dir,
      headFile,
      bodyFile,
      exist: fs.existsSync(headFile),
    };
  }
}
