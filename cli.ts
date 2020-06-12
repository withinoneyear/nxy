#!/usr/bin/env node

import fs from "fs";
import SimpleProxy from "./proxy";
import command from "command-line-args";
import chalk from "chalk";

const optionDef = [
  { name: "port", alias: "p", type: Number },
  { name: "ssl-key", type: String },
  { name: "ssl-cert", type: String },
  { name: "verbose", alias: "v", type: Boolean },
  { name: "inspector-dir", type: String },
  { name: "cache-dir", type: String },
  { name: "clear-cache", type: Boolean },
  { name: "rule", alias: "r", type: String, multiple: true },
  { name: "rule-file", alias: "f", type: String },
  { name: "output", alias: "o", type: String },
];
const options = command(optionDef);

const rules = options.rule || [];
const file = options["rule-file"];
if (file) {
  if (!fs.existsSync(file)) {
    console.log(chalk.red("Rule file specified does not exist!"));
    process.exit(1);
  }
  const lines = fs
    .readFileSync(file, { encoding: "utf-8" })
    .split("\n")
    .filter((x) => x.trim().length)
    .forEach((x) => rules.push(x));
}

const proxy = new SimpleProxy({
  port: options.port | 8080,
  sslCert: {
    key: options["ssl-key"],
    cert: options["ssl-cert"],
  },
  log: console.log,
  onError: (type, err) => {
    console.log(chalk.red(`[${type}] ${err}`));
  },
  inspector: {
    // keep: true, // uncommet it to prevent temporary files being deleted
    dir: options["inspector-dir"],
    OnResponseEnd: (entry) => {
      if (options.verbose || entry.rule) {
        const msg = [
          entry.rule,
          entry.res?.statusCode,
          `${entry.req.headers.host}${entry.req.url}`,
        ].join("\t");
        if (options.output) fs.appendFileSync(options.output, msg + "\n");
        else console.log(entry.rule ? chalk.bold.green(msg) : msg);
      }
    },
  },
  cacheDir: options["cache-dir"],
  clearCacheOnStart: options["clear-cache"],
});

rules.forEach((r: string) => {
  const [rule, path, args] = r.split("|");
  const reg = /^\((.*?)\)$/.exec(path) || [];
  const url = reg[1] ? new RegExp(reg[1]) : path;
  if (!(rule in proxy)) {
    console.log(chalk.red(`Rule [${rule}] not supported!`));
    process.exit(1);
  }
  if (options.verbose)
    console.log(chalk.blue(`Rule [${rule}] added for ${path}`));
  (proxy as any)[rule](url, args);
});

proxy.start();

process.on("unhandledRejection", (reason: any) => {
  console.log("Unhandled Rejection at:", reason.stack || reason);
});
