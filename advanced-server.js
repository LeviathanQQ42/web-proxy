const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const acorn = require('acorn');
const walk = require('acorn-walk');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

const cache = new NodeCache({ 
    stdTTL: 600,
    checkperiod: 120,
    maxKeys: 1000,
    useClones: false
});

app.use(compression());
app.use(cors());
app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

const axiosInstance = axios.create({
    timeout: 10000,
    maxRedirects: 5,
    decompress: true,
    maxContentLength: 100 * 1024 * 1024,
    httpAgent: new http.Agent({ 
        keepAlive: true,
        keepAliveMsecs: 1000,
        maxSockets: 200,
        maxFreeSockets: 20
    }),
    httpsAgent: new https.Agent({ 
        keepAlive: true,
        keepAliveMsecs: 1000,
        maxSockets: 200,
        maxFreeSockets: 20,
        rejectUnauthorized: false
    })
});

function rewriteJavaScript(jsCode, baseUrl, proxyUrl) {
    try {
        const patterns = [
            { regex: /fetch\s*\(\s*["'`]([^"'`]+)["'`]/g, replacement: (match, url) => {
                if (url.startsWith('http')) {
                    return `fetch("${proxyUrl}/proxy?url=${encodeURIComponent(url)}"`;
                } else if (url.startsWith('//')) {
                    return `fetch("${proxyUrl}/proxy?url=${encodeURIComponent('https:' + url)}"`;
                } else if (url.startsWith('/')) {
                    const base = new URL(baseUrl);
                    return `fetch("${proxyUrl}/proxy?url=${encodeURIComponent(base.origin + url)}"`;
                }
                return match;
            }},
            { regex: /XMLHttpRequest\.open\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*["'`]([^"'`]+)["'`]/g, replacement: (match, method, url) => {
                if (url.startsWith('http')) {
                    return `XMLHttpRequest.open("${method}", "${proxyUrl}/proxy?url=${encodeURIComponent(url)}"`;
                }
                return match;
            }},
            { regex: /window\.location\.href\s*=\s*["'`]([^"'`]+)["'`]/g, replacement: (match, url) => {
                if (url.startsWith('http')) {
                    return `window.location.href = "${proxyUrl}/proxy?url=${encodeURIComponent(url)}"`;
                }
                return match;
            }}
        ];

        let modifiedCode = jsCode;
        patterns.forEach(pattern => {
            modifiedCode = modifiedCode.replace(pattern.regex, pattern.replacement);
        });

        const injectedCode = `
(function() {
    const originalFetch = window.fetch;
    const proxyBase = '${proxyUrl}';
    const currentBase = '${baseUrl}';
    
    window.fetch = function(url, options) {
        if (typeof url === 'string') {
            if (url.startsWith('http')) {
                url = proxyBase + '/proxy?url=' + encodeURIComponent(url);
            } else if (url.startsWith('//')) {
                url = proxyBase + '/proxy?url=' + encodeURIComponent('https:' + url);
            } else if (url.startsWith('/')) {
                const base = new URL(currentBase);
                url = proxyBase + '/proxy?url=' + encodeURIComponent(base.origin + url);
            }
        }
        return originalFetch(url, options);
    };
    
    const originalXHROpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
        if (url.startsWith('http')) {
            url = proxyBase + '/proxy?url=' + encodeURIComponent(url);
        } else if (url.startsWith('//')) {
            url = proxyBase + '/proxy?url=' + encodeURIComponent('https:' + url);
        } else if (url.startsWith('/')) {
            const base = new URL(currentBase);
            url = proxyBase + '/proxy?url=' + encodeURIComponent(base.origin + url);
        }
        return originalXHROpen.apply(this, [method, url, ...Array.from(arguments).slice(2)]);
    };
})();
`;
        
        return injectedCode + '\n' + modifiedCode;
    } catch (e) {
        console.error('JS rewrite error:', e);
        return jsCode;
    }
}

function rewriteHtml(html, baseUrl, proxyUrl) {
    const $ = cheerio.load(html, {
        decodeEntities: false,
        xml: false
    });
    
    $('script[src*="analytics"], script[src*="tracking"]').remove();
    
    const serviceWorkerScript = `
<script>
(function() {
    const proxyBase = '${proxyUrl}';
    const currentBase = '${baseUrl}';
    
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register = function() {
            return Promise.resolve({ scope: '/' });
        };
    }
    
    const originalPushState = history.pushState;
    history.pushState = function(state, title, url) {
        if (url && url.startsWith('http')) {
            url = proxyBase + '/proxy?url=' + encodeURIComponent(url);
        }
        return originalPushState.call(this, state, title, url);
    };
    
    const originalReplaceState = history.replaceState;
    history.replaceState = function(state, title, url) {
        if (url && url.startsWith('http')) {
            url = proxyBase + '/proxy?url=' + encodeURIComponent(url);
        }
        return originalReplaceState.call(this, state, title, url);
    };
    
    document.addEventListener('DOMContentLoaded', function() {
        const observer = new MutationObserver(function(mutations) {
            mutations.forEach(function(mutation) {
                mutation.addedNodes.forEach(function(node) {
                    if (node.tagName === 'SCRIPT' && node.src) {
                        if (!node.src.includes(proxyBase)) {
                            const originalSrc = node.src;
                            node.src = proxyBase + '/proxy?url=' + encodeURIComponent(originalSrc);
                        }
                    }
                });
            });
        });
        
        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    });
})();
</script>
`;
    
    $('head').prepend(serviceWorkerScript);
    
    $('a[href]').each((i, elem) => {
        const href = $(elem).attr('href');
        if (href && !href.startsWith('javascript:') && !href.startsWith('#')) {
            try {
                const absoluteUrl = new URL(href, baseUrl).toString();
                $(elem).attr('href', `${proxyUrl}/proxy?url=${encodeURIComponent(absoluteUrl)}`);
            } catch (e) {}
        }
    });
    
    $('img[src], script[src], link[href], iframe[src], source[src], video[src], audio[src]').each((i, elem) => {
        const $elem = $(elem);
        const attrName = $elem.attr('src') !== undefined ? 'src' : 'href';
        const attrValue = $elem.attr(attrName);
        
        if (attrValue && !attrValue.startsWith('data:') && !attrValue.startsWith(proxyUrl)) {
            try {
                const absoluteUrl = new URL(attrValue, baseUrl).toString();
                if (elem.tagName === 'script' || elem.tagName === 'link') {
                    $elem.attr(attrName, `${proxyUrl}/proxy?url=${encodeURIComponent(absoluteUrl)}`);
                } else {
                    $elem.attr(attrName, `${proxyUrl}/proxy?url=${encodeURIComponent(absoluteUrl)}`);
                }
            } catch (e) {}
        }
    });
    
    $('style').each((i, elem) => {
        const $elem = $(elem);
        let css = $elem.html();
        if (css) {
            css = css.replace(/url\(['"]?([^'")]+)['"]?\)/g, (match, url) => {
                if (url && !url.startsWith('data:')) {
                    try {
                        const absoluteUrl = new URL(url, baseUrl).toString();
                        return `url('${proxyUrl}/proxy?url=${encodeURIComponent(absoluteUrl)}')`;
                    } catch (e) {}
                }
                return match;
            });
            $elem.html(css);
        }
    });
    
    $('meta[http-equiv="Content-Security-Policy"]').remove();
    $('meta[http-equiv="refresh"]').remove();
    
    return $.html();
}

app.get('/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    
    if (!targetUrl) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }
    
    const proxyUrl = `${req.protocol}://${req.get('host')}`;
    
    try {
        const parsedUrl = new URL(targetUrl);
        const cookieHeader = req.headers.cookie ? req.headers.cookie.replace(/proxy_/g, '') : '';
        
        const response = await axiosInstance.get(targetUrl, {
            headers: {
                'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': req.headers['accept'] || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Accept-Encoding': 'gzip, deflate, br',
                'Referer': parsedUrl.origin,
                'Cookie': cookieHeader,
                'Cache-Control': 'no-cache'
            },
            responseType: 'arraybuffer',
            validateStatus: () => true
        });
        
        const contentType = response.headers['content-type'] || 'text/plain';
        
        if (response.headers['set-cookie']) {
            const cookies = Array.isArray(response.headers['set-cookie']) 
                ? response.headers['set-cookie'] 
                : [response.headers['set-cookie']];
            
            cookies.forEach(cookie => {
                const modifiedCookie = cookie
                    .replace(/domain=[^;]+;?/gi, '')
                    .replace(/secure;?/gi, '')
                    .replace(/samesite=[^;]+;?/gi, '');
                res.append('Set-Cookie', 'proxy_' + modifiedCookie);
            });
        }
        
        Object.keys(response.headers).forEach(key => {
            if (!['content-encoding', 'content-length', 'transfer-encoding', 'set-cookie'].includes(key.toLowerCase())) {
                res.set(key, response.headers[key]);
            }
        });
        
        if (contentType.includes('text/html')) {
            const html = response.data.toString('utf-8');
            const modifiedHtml = rewriteHtml(html, targetUrl, proxyUrl);
            res.set('Content-Type', 'text/html; charset=utf-8');
            res.send(modifiedHtml);
        } else if (contentType.includes('javascript') || contentType.includes('application/json')) {
            const jsCode = response.data.toString('utf-8');
            const modifiedJs = rewriteJavaScript(jsCode, targetUrl, proxyUrl);
            res.set('Content-Type', contentType);
            res.send(modifiedJs);
        } else if (contentType.includes('text/css')) {
            let css = response.data.toString('utf-8');
            css = css.replace(/url\(['"]?([^'")]+)['"]?\)/g, (match, url) => {
                if (url && !url.startsWith('data:')) {
                    try {
                        const absoluteUrl = new URL(url, targetUrl).toString();
                        return `url('${proxyUrl}/proxy?url=${encodeURIComponent(absoluteUrl)}')`;
                    } catch (e) {}
                }
                return match;
            });
            res.set('Content-Type', 'text/css');
            res.send(css);
        } else {
            res.send(response.data);
        }
    } catch (error) {
        console.error('Proxy error:', error.message);
        res.status(500).json({ 
            error: 'Failed to fetch the requested URL',
            message: error.message 
        });
    }
});

const wss = new WebSocket.Server({ server, path: '/ws-proxy' });

wss.on('connection', (ws, req) => {
    const urlParams = new URL(req.url, `http://${req.headers.host}`).searchParams;
    const targetUrl = urlParams.get('url');
    
    if (!targetUrl) {
        ws.close(1002, 'URL parameter required');
        return;
    }
    
    try {
        const parsedUrl = new URL(targetUrl);
        const targetWs = new WebSocket(targetUrl);
        
        targetWs.on('open', () => {
            console.log('WebSocket connection established to:', targetUrl);
        });
        
        targetWs.on('message', (data) => {
            ws.send(data);
        });
        
        ws.on('message', (data) => {
            targetWs.send(data);
        });
        
        targetWs.on('close', () => {
            ws.close();
        });
        
        ws.on('close', () => {
            targetWs.close();
        });
        
        targetWs.on('error', (err) => {
            console.error('Target WebSocket error:', err);
            ws.close(1002, 'Target connection failed');
        });
        
    } catch (error) {
        ws.close(1002, 'Invalid URL');
    }
});

app.post('/api/proxy', async (req, res) => {
    const { url: targetUrl } = req.body;
    
    if (!targetUrl) {
        return res.status(400).json({ error: 'URL is required' });
    }
    
    try {
        let finalUrl = targetUrl;
        if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
            finalUrl = 'https://' + targetUrl;
        }
        
        const proxyUrl = `${req.protocol}://${req.get('host')}`;
        
        res.json({ 
            success: true, 
            proxyUrl: `${proxyUrl}/proxy?url=${encodeURIComponent(finalUrl)}`,
            directUrl: finalUrl
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'Failed to access the URL',
            message: error.message 
        });
    }
});

server.listen(PORT, () => {
    console.log(`🚀 Advanced Proxy Server running on http://localhost:${PORT}`);
    console.log(`📡 WebSocket proxy enabled`);
    console.log(`🔧 JavaScript rewriting active`);
    console.log(`🍪 Cookie handling enabled`);
    console.log(`🔄 Dynamic content support`);
});