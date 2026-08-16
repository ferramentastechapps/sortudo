// Simple, fast Node static file server (no caching)
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = 3030;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.ico':  'image/x-icon'
};

import apiResultsHandler from './api/results.js';

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  let reqPath = parsedUrl.pathname;

  // Rota serverless local para /api/results
  if (reqPath === '/api/results') {
    const query = Object.fromEntries(parsedUrl.searchParams.entries());
    const reqMock = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      query
    };
    const resMock = {
      statusCode: 200,
      headers: {},
      setHeader(name, val) {
        this.headers[name] = val;
        res.setHeader(name, val);
      },
      status(code) {
        this.statusCode = code;
        res.statusCode = code;
        return this;
      },
      json(data) {
        this.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.writeHead(this.statusCode);
        res.end(JSON.stringify(data));
      },
      end(data) {
        res.writeHead(this.statusCode);
        res.end(data);
      }
    };
    try {
      await apiResultsHandler(reqMock, resMock);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.join(__dirname, reqPath);

  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'text/plain';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
    } else {
      // Fix #24: Cache inteligente — HTML sempre fresco, assets com 1h de cache
      const isHtml = ext === '.html' || ext === '';
      const cacheControl = isHtml
        ? 'no-store, no-cache, must-revalidate'
        : 'public, max-age=3600, stale-while-revalidate=86400';

      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': cacheControl,
        'Access-Control-Allow-Origin': '*',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(content);
    }
  });
});

server.listen(PORT, () => {
  console.log(`[Sortudo Server] Listening on http://localhost:${PORT}`);
});
