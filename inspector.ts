import {
  IncomingMessage,
  IncomingHttpHeaders,
  OutgoingHttpHeaders,
} from "http";
import tmp from "tmp";
import fs from "fs";
import path from "path";
import { Readable, pipeline } from "stream";
import { RuleResponse } from "./rules";

export interface IReq {
  url?: string;
  method?: string;
  httpVersion: string;
  headers: IncomingHttpHeaders;
}

export interface IRes {
  readableObjectMode?: boolean;
  headers: OutgoingHttpHeaders;
  statusCode?: number;
  statusMessage?: string;
}

export interface IEntry {
  seq: number;
  req: IReq;
  res?: IRes;
  rule?: string;
}

export interface IInspector {
  dir?: string;
  onRequest: (seq: number, req: IncomingMessage, rule?: string) => void;
  onRespond: (seq: number, res: RuleResponse) => void;
}

export interface IInspectorArgs {
  dir?: string;
  keep?: boolean;
  onRequestEnd?: (entry: IEntry) => void;
  OnResponseEnd?: (entry: IEntry) => void;
}

export class Inspector implements IInspector {
  dir?: string;
  match = /.*/;
  onRequestEnd: IInspectorArgs["onRequestEnd"];
  onResponseEnd: IInspectorArgs["OnResponseEnd"];

  private entries: IEntry[] = [];
  constructor(args: IInspectorArgs = { keep: false }) {
    this.dir = args.dir
      ? args.dir
      : tmp.dirSync({ keep: args.keep, unsafeCleanup: true }).name;

    this.onRequestEnd = args.onRequestEnd || (() => {});
    this.onResponseEnd = args.OnResponseEnd || (() => {});
  }

  onRequest: IInspector["onRequest"] = (seq, req, rule) => {
    const { url, method, httpVersion, headers } = req;
    this.entries[seq] = {
      seq,
      req: {
        url,
        method,
        httpVersion,
        headers,
      },
      res: {
        headers: {},
      },
      rule,
    };
    this.saveEntries();

    req
      .on("data", (chunk) => {
        this.writeReq(seq, chunk);
      })
      .on("end", () => this.onRequestEnd!(this.entries[seq]));
  };

  onRespond: IInspector["onRespond"] = (seq, res) => {
    const { headers = {}, statusCode, statusMessage } = res;
    this.entries[seq].res = {
      headers,
      statusCode,
      statusMessage,
    };
    this.saveEntries();

    const stream = res.body || res;
    const file = path.join(this.dir!, `${seq}.res`);
    if (stream instanceof Readable) {
      pipeline(stream, fs.createWriteStream(file), (err) => {
        if (!err) this.onResponseEnd!(this.entries[seq]);
      });
    }
  };

  private writeReq(seq: number, chunk: any) {
    const file = path.join(this.dir!, `${seq}.req`);
    fs.appendFileSync(file, chunk);
  }

  private nextSaveTime = Date.now();
  private timer?: NodeJS.Timeout;
  private saveEntries() {
    let timeLeft = this.nextSaveTime - Date.now();
    if (timeLeft < 0) this.nextSaveTime = 2000;
    if (timeLeft <= 2000) {
      this.nextSaveTime += 2000;
    } else {
      if (this.timer) clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      const file = path.join(this.dir!, "index.json");
      fs.writeFileSync(file, JSON.stringify(this.entries));
    }, this.nextSaveTime);
  }
}
