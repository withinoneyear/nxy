Simple http/https for web dev. No support for http/2 and websocket.

# CLI

If installed with `npm install nxy -g` it can be used as a global command for proxy.

## Options

-p --port: proxy port. Default to 8080

-v --verbose: verbose log

-o --output: file path to save log

--ssl-key: file path to ssl key

--ssl-cert: file path to ssl cert

--inspecctor-dir: directory path to save temporary files for inspection

--cache-dir: directory path to save files for cache

--clear-cache: clear cache files on start up

-r --rule: rule string to apply:

- delay|(www\.bing\.com\\/\$)|5000
- content|/test.js|test content
- file|/test.js|/test.mock.js
- forward|/test.js|https://www.google.com
- cache|test/\*.js|3600

--rule-file: the file location which contains the list of rules. Rule syntax is the same as above.

# Module

npm install nxy

```
import Xy from 'nxy';

const xy = new Xy({
  port: 8080,
  sslCert: {
    key: "/Users/jp/.ssh/xy-root-ca.key.pem",
    cert: "/Users/jp/.ssh/xy-root-ca.crt.pem",
  },
  log: console.log,
  onError: (type, err) => {
    console.log(`[${type}] ${err}`);
  },
  inspector: {
    // keep: true, // uncommet it to prevent temporary files being deleted
    // dir: '/tmp',
    // onRequestEnd: (entry) => {},
    OnResponseEnd: (entry) => {
        console.log(entry.req.url);
    },
  },
  // cacheDir: '/.cache',
  // clearCacheOnStart: false,
});
```

```
xy.delay('http://www.bing.com/*', 5000);
xy.content('http://www.google.com', 'test google content');
xy.file(/www\.facebook\.com\/$/, '/facebook.mock.txt');
xy.forward(/www\.yahoo\.com\/$/, 'https://www.google.com');
xy.cache('www.github.com', 3600);
// xy.addCustomRule({...});
```

```
xy.start();
```
