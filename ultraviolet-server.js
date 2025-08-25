const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const http = require('http');
const https = require('https');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

app.use(compression());
app.use(cors({
    origin: true,
    credentials: true
}));
app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

const axiosInstance = axios.create({
    timeout: 15000,
    maxRedirects: 5,
    decompress: true,
    maxContentLength: 100 * 1024 * 1024,
    httpAgent: new http.Agent({ 
        keepAlive: true,
        maxSockets: 200
    }),
    httpsAgent: new https.Agent({ 
        keepAlive: true,
        maxSockets: 200,
        rejectUnauthorized: false
    })
});

function encodeUrl(url) {
    return Buffer.from(url).toString('base64').replace(/=/g, '');
}

function decodeUrl(encoded) {
    return Buffer.from(encoded, 'base64').toString('utf-8');
}

function rewriteHtml(html, baseUrl) {
    const $ = cheerio.load(html, {
        decodeEntities: false,
        xml: false
    });
    
    // Remove security policies
    $('meta[http-equiv="Content-Security-Policy"]').remove();
    $('meta[http-equiv="X-Frame-Options"]').remove();
    $('meta[name="referrer"]').attr('content', 'no-referrer');
    
    // Add base tag for relative URLs
    const base = new URL(baseUrl);
    if (!$('base').length) {
        $('head').prepend(`<base href="${baseUrl}">`);
    }
    
    // Inject our proxy script FIRST before any other scripts
    const proxyScript = `
<script data-proxy="true">
(function() {
    // Store original functions
    const _fetch = window.fetch;
    const _xhrOpen = XMLHttpRequest.prototype.open;
    const _appendChild = Node.prototype.appendChild;
    const _insertBefore = Node.prototype.insertBefore;
    const _setAttribute = Element.prototype.setAttribute;
    
    const proxyBase = '${base.protocol}//${base.host}';
    const currentOrigin = window.location.origin;
    
    // Helper to proxy URL
    function proxyUrl(url) {
        if (!url) return url;
        try {
            if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('javascript:')) {
                return url;
            }
            
            let absoluteUrl;
            if (url.startsWith('http://') || url.startsWith('https://')) {
                absoluteUrl = url;
            } else if (url.startsWith('//')) {
                absoluteUrl = 'https:' + url;
            } else if (url.startsWith('/')) {
                absoluteUrl = proxyBase + url;
            } else {
                absoluteUrl = proxyBase + '/' + url;
            }
            
            return currentOrigin + '/~/' + btoa(absoluteUrl).replace(/=/g, '');
        } catch(e) {
            return url;
        }
    }
    
    // Override fetch
    window.fetch = function(resource, init) {
        if (typeof resource === 'string') {
            resource = proxyUrl(resource);
        } else if (resource instanceof Request) {
            resource = new Request(proxyUrl(resource.url), resource);
        }
        return _fetch.call(this, resource, init);
    };
    
    // Override XMLHttpRequest
    XMLHttpRequest.prototype.open = function(method, url) {
        arguments[1] = proxyUrl(url);
        return _xhrOpen.apply(this, arguments);
    };
    
    // Override setAttribute for src/href
    Element.prototype.setAttribute = function(name, value) {
        if ((name === 'src' || name === 'href') && value && !this.hasAttribute('data-proxied')) {
            value = proxyUrl(value);
            this.setAttribute('data-proxied', 'true');
            _setAttribute.call(this, name, value);
            this.removeAttribute('data-proxied');
        } else if (name !== 'data-proxied') {
            _setAttribute.call(this, name, value);
        }
    };
    
    // Override appendChild to catch dynamic scripts
    Node.prototype.appendChild = function(child) {
        if (child && child.tagName === 'SCRIPT' && child.src && !child.hasAttribute('data-proxy')) {
            child.src = proxyUrl(child.src);
        }
        return _appendChild.call(this, child);
    };
    
    // Override insertBefore
    Node.prototype.insertBefore = function(newNode, referenceNode) {
        if (newNode && newNode.tagName === 'SCRIPT' && newNode.src && !newNode.hasAttribute('data-proxy')) {
            newNode.src = proxyUrl(newNode.src);
        }
        return _insertBefore.call(this, newNode, referenceNode);
    };
    
    // Override Image constructor
    const _Image = window.Image;
    window.Image = function(width, height) {
        const img = new _Image(width, height);
        const _setSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src').set;
        Object.defineProperty(img, 'src', {
            set: function(value) {
                _setSrc.call(this, proxyUrl(value));
            },
            get: function() {
                return this.getAttribute('src');
            }
        });
        return img;
    };
    
    // Handle window.location
    const _pushState = history.pushState;
    history.pushState = function(state, title, url) {
        if (url) url = proxyUrl(url);
        return _pushState.call(this, state, title, url);
    };
    
    const _replaceState = history.replaceState;
    history.replaceState = function(state, title, url) {
        if (url) url = proxyUrl(url);
        return _replaceState.call(this, state, title, url);
    };
})();
</script>
`;
    
    $('head').prepend(proxyScript);
    
    // Rewrite all URLs in attributes
    $('[src], [href], [action]').each((i, elem) => {
        const $elem = $(elem);
        ['src', 'href', 'action'].forEach(attr => {
            const value = $elem.attr(attr);
            if (value && !value.startsWith('data:') && !value.startsWith('javascript:')) {
                try {
                    let absoluteUrl;
                    if (value.startsWith('http://') || value.startsWith('https://')) {
                        absoluteUrl = value;
                    } else if (value.startsWith('//')) {
                        absoluteUrl = 'https:' + value;
                    } else {
                        absoluteUrl = new URL(value, baseUrl).toString();
                    }
                    $elem.attr(attr, `/~/${encodeUrl(absoluteUrl)}`);
                } catch(e) {}
            }
        });
    });
    
    // Rewrite inline styles
    $('style').each((i, elem) => {
        const $elem = $(elem);
        let css = $elem.html();
        if (css) {
            css = css.replace(/url\(['"]?([^'")]+)['"]?\)/g, (match, url) => {
                if (url && !url.startsWith('data:')) {
                    try {
                        const absoluteUrl = new URL(url, baseUrl).toString();
                        return `url('/~/${encodeUrl(absoluteUrl)}')`;
                    } catch(e) {}
                }
                return match;
            });
            $elem.html(css);
        }
    });
    
    return $.html();
}

function rewriteJs(js, baseUrl) {
    // Simple URL replacements in JavaScript
    const patterns = [
        { regex: /["']https?:\/\/[^"']+["']/g, replacement: (match) => {
            const url = match.slice(1, -1);
            const quote = match[0];
            return `${quote}/~/${encodeUrl(url)}${quote}`;
        }},
        { regex: /["']\/\/[^"']+["']/g, replacement: (match) => {
            const url = 'https:' + match.slice(1, -1);
            const quote = match[0];
            return `${quote}/~/${encodeUrl(url)}${quote}`;
        }}
    ];
    
    let modified = js;
    patterns.forEach(pattern => {
        modified = modified.replace(pattern.regex, pattern.replacement);
    });
    
    return modified;
}

function rewriteCss(css, baseUrl) {
    return css.replace(/url\(['"]?([^'")]+)['"]?\)/g, (match, url) => {
        if (url && !url.startsWith('data:')) {
            try {
                const absoluteUrl = new URL(url, baseUrl).toString();
                return `url('/~/${encodeUrl(absoluteUrl)}')`;
            } catch(e) {}
        }
        return match;
    });
}

// Main proxy route
app.get('/~/:encoded(*)', async (req, res) => {
    try {
        const targetUrl = decodeUrl(req.params.encoded);
        
        const headers = {
            'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': req.headers['accept'] || '*/*',
            'Accept-Language': req.headers['accept-language'] || 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Cache-Control': 'no-cache'
        };
        
        // Forward cookies
        if (req.headers.cookie) {
            headers['Cookie'] = req.headers.cookie;
        }
        
        // Add referer
        if (req.headers.referer) {
            try {
                const refererPath = req.headers.referer.split('/~/')[1];
                if (refererPath) {
                    headers['Referer'] = decodeUrl(refererPath.split('?')[0]);
                }
            } catch(e) {}
        }
        
        const response = await axiosInstance({
            method: 'GET',
            url: targetUrl,
            headers: headers,
            responseType: 'arraybuffer',
            validateStatus: () => true
        });
        
        // Forward response headers
        Object.keys(response.headers).forEach(key => {
            const lowerKey = key.toLowerCase();
            if (!['content-encoding', 'content-length', 'transfer-encoding', 'content-security-policy', 'x-frame-options', 'strict-transport-security'].includes(lowerKey)) {
                res.set(key, response.headers[key]);
            }
        });
        
        // Remove security headers
        res.removeHeader('X-Frame-Options');
        res.removeHeader('Content-Security-Policy');
        res.set('Access-Control-Allow-Origin', '*');
        
        const contentType = response.headers['content-type'] || 'text/plain';
        
        if (contentType.includes('text/html')) {
            const html = response.data.toString('utf-8');
            const rewritten = rewriteHtml(html, targetUrl);
            res.send(rewritten);
        } else if (contentType.includes('javascript') || contentType.includes('application/json')) {
            const js = response.data.toString('utf-8');
            const rewritten = rewriteJs(js, targetUrl);
            res.send(rewritten);
        } else if (contentType.includes('text/css')) {
            const css = response.data.toString('utf-8');
            const rewritten = rewriteCss(css, targetUrl);
            res.send(rewritten);
        } else {
            res.send(response.data);
        }
        
    } catch (error) {
        console.error('Proxy error:', error.message);
        res.status(500).send('Proxy error: ' + error.message);
    }
});

// API endpoint for initial proxy
app.post('/api/proxy', (req, res) => {
    const { url } = req.body;
    
    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }
    
    let finalUrl = url;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        finalUrl = 'https://' + url;
    }
    
    const encoded = encodeUrl(finalUrl);
    const proxyUrl = `/~/${encoded}`;
    
    res.json({ 
        success: true, 
        proxyUrl: proxyUrl,
        directUrl: finalUrl
    });
});

// For Vercel deployment
if (process.env.VERCEL) {
    module.exports = app;
} else {
    server.listen(PORT, () => {
        console.log(`⚡ Ultraviolet-style Proxy running on http://localhost:${PORT}`);
        console.log(`🔒 CORS bypassed via path-based routing`);
        console.log(`🎯 All resources proxied through /~/ path`);
        console.log(`💉 JavaScript injection for dynamic content`);
    });
}

// Export for Vercel
module.exports = app;