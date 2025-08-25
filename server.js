const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const url = require('url');
const NodeCache = require('node-cache');
const compression = require('compression');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
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
app.use(express.static('public'));

const axiosInstance = axios.create({
    timeout: 8000,
    maxRedirects: 3,
    responseType: 'stream',
    decompress: true,
    maxContentLength: 50 * 1024 * 1024,
    httpAgent: new (require('http').Agent)({ 
        keepAlive: true,
        keepAliveMsecs: 1000,
        maxSockets: 100,
        maxFreeSockets: 10
    }),
    httpsAgent: new (require('https').Agent)({ 
        keepAlive: true,
        keepAliveMsecs: 1000,
        maxSockets: 100,
        maxFreeSockets: 10,
        rejectUnauthorized: false
    })
});

function simplifyUrl(html, baseUrl) {
    const $ = cheerio.load(html, {
        decodeEntities: false,
        xml: false
    });
    
    $('script[src*="analytics"], script[src*="tracking"], script[src*="gtag"]').remove();
    $('link[rel="preconnect"], link[rel="dns-prefetch"]').remove();
    $('meta[http-equiv="refresh"]').remove();
    
    const elementsWithUrls = $('a[href], img[src], script[src], link[href], iframe[src], source[src], video[src]');
    
    elementsWithUrls.each((i, elem) => {
        const $elem = $(elem);
        const attrName = $elem.attr('href') !== undefined ? 'href' : 'src';
        const attrValue = $elem.attr(attrName);
        
        if (attrValue && !attrValue.startsWith('data:') && !attrValue.startsWith('javascript:')) {
            try {
                if (elem.tagName === 'a') {
                    const absoluteUrl = new URL(attrValue, baseUrl).toString();
                    $elem.attr('href', `/proxy?url=${encodeURIComponent(absoluteUrl)}`);
                } else {
                    const absoluteUrl = new URL(attrValue, baseUrl).toString();
                    $elem.attr(attrName, absoluteUrl);
                }
            } catch (e) {}
        }
    });
    
    const styleContent = `
        <style>
            * { transition: none !important; animation: none !important; }
            img { loading: lazy; }
        </style>
    `;
    $('head').append(styleContent);
    
    return $.html();
}

app.get('/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    
    if (!targetUrl) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }
    
    const cacheKey = `proxy_${targetUrl}`;
    const cachedResponse = cache.get(cacheKey);
    
    if (cachedResponse) {
        res.set('X-Cache', 'HIT');
        res.set('Content-Type', cachedResponse.contentType);
        return res.send(cachedResponse.data);
    }
    
    try {
        const response = await axiosInstance.get(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Accept-Encoding': 'gzip, deflate, br',
                'Cache-Control': 'max-age=0'
            },
            responseType: 'arraybuffer'
        });
        
        const contentType = response.headers['content-type'] || 'text/plain';
        
        if (contentType.includes('text/html')) {
            const html = response.data.toString('utf-8');
            const modifiedHtml = simplifyUrl(html, targetUrl);
            
            cache.set(cacheKey, {
                data: modifiedHtml,
                contentType: 'text/html; charset=utf-8'
            });
            
            res.set('Content-Type', 'text/html; charset=utf-8');
            res.set('X-Cache', 'MISS');
            res.send(modifiedHtml);
        } else {
            if (response.data.length < 5 * 1024 * 1024) {
                cache.set(cacheKey, {
                    data: response.data,
                    contentType: contentType
                });
            }
            
            res.set('Content-Type', contentType);
            res.set('X-Cache', 'MISS');
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

app.use('/fast-proxy', createProxyMiddleware({
    changeOrigin: true,
    ws: true,
    router: (req) => {
        const targetUrl = req.query.url;
        if (!targetUrl) return null;
        try {
            const parsed = new URL(targetUrl);
            return `${parsed.protocol}//${parsed.host}`;
        } catch {
            return null;
        }
    },
    pathRewrite: (path, req) => {
        const targetUrl = req.query.url;
        if (!targetUrl) return path;
        try {
            const parsed = new URL(targetUrl);
            return parsed.pathname + parsed.search;
        } catch {
            return path;
        }
    },
    onProxyRes: (proxyRes, req, res) => {
        proxyRes.headers['x-proxy-cache'] = 'BYPASS';
    },
    onError: (err, req, res) => {
        res.status(500).json({ error: 'Proxy error', message: err.message });
    }
}));

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
        
        const cacheKey = `check_${finalUrl}`;
        const cachedCheck = cache.get(cacheKey);
        
        if (cachedCheck) {
            return res.json(cachedCheck);
        }
        
        const response = await axiosInstance.head(finalUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 3000
        });
        
        const result = { 
            success: true, 
            proxyUrl: `/proxy?url=${encodeURIComponent(finalUrl)}`,
            fastProxyUrl: `/fast-proxy?url=${encodeURIComponent(finalUrl)}`,
            directUrl: finalUrl
        };
        
        cache.set(cacheKey, result, 300);
        res.json(result);
    } catch (error) {
        res.status(500).json({ 
            error: 'Failed to access the URL',
            message: error.message 
        });
    }
});

app.get('/api/cache/clear', (req, res) => {
    cache.flushAll();
    res.json({ success: true, message: 'Cache cleared' });
});

app.get('/api/cache/stats', (req, res) => {
    res.json(cache.getStats());
});

app.listen(PORT, () => {
    console.log(`🚀 Fast Proxy server running on http://localhost:${PORT}`);
    console.log(`📊 Cache enabled with 10-minute TTL`);
    console.log(`🔄 Connection pooling active`);
    console.log(`📦 Compression enabled`);
});