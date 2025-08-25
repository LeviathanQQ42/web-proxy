document.addEventListener('DOMContentLoaded', () => {
    const urlInput = document.getElementById('urlInput');
    const openDirectBtn = document.getElementById('openDirectBtn');
    const openProxyBtn = document.getElementById('openProxyBtn');
    const errorMessage = document.getElementById('errorMessage');
    const proxyFrame = document.getElementById('proxyFrame');
    const proxyIframe = document.getElementById('proxyIframe');
    const currentUrl = document.getElementById('currentUrl');
    const closeFrameBtn = document.getElementById('closeFrameBtn');
    
    function showError(message) {
        errorMessage.textContent = message;
        errorMessage.classList.add('show');
        setTimeout(() => {
            errorMessage.classList.remove('show');
        }, 5000);
    }
    
    function hideError() {
        errorMessage.classList.remove('show');
    }
    
    function validateUrl(url) {
        if (!url.trim()) {
            showError('Please enter a URL');
            return false;
        }
        return true;
    }
    
    function formatUrl(url) {
        url = url.trim();
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            url = 'https://' + url;
        }
        return url;
    }
    
    openDirectBtn.addEventListener('click', async () => {
        const url = urlInput.value;
        
        if (!validateUrl(url)) return;
        
        hideError();
        openDirectBtn.disabled = true;
        openDirectBtn.textContent = 'Loading...';
        
        try {
            const formattedUrl = formatUrl(url);
            
            const response = await fetch('/api/proxy', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ url: formattedUrl })
            });
            
            const data = await response.json();
            
            if (data.success) {
                const proxyUrl = window.location.origin + data.proxyUrl;
                window.open(proxyUrl, '_blank');
            } else {
                showError(data.error || 'Failed to access the URL');
            }
        } catch (error) {
            showError('Network error. Please try again.');
            console.error('Error:', error);
        } finally {
            openDirectBtn.disabled = false;
            openDirectBtn.textContent = 'Open Direct';
        }
    });
    
    openProxyBtn.addEventListener('click', async () => {
        const url = urlInput.value;
        
        if (!validateUrl(url)) return;
        
        hideError();
        openProxyBtn.disabled = true;
        openProxyBtn.textContent = 'Loading...';
        
        try {
            const formattedUrl = formatUrl(url);
            
            const response = await fetch('/api/proxy', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ url: formattedUrl })
            });
            
            const data = await response.json();
            
            if (data.success) {
                const proxyUrl = window.location.origin + data.proxyUrl;
                proxyIframe.src = proxyUrl;
                currentUrl.textContent = formattedUrl;
                proxyFrame.classList.remove('hidden');
                
                proxyFrame.scrollIntoView({ behavior: 'smooth', block: 'start' });
            } else {
                showError(data.error || 'Failed to access the URL');
            }
        } catch (error) {
            showError('Network error. Please try again.');
            console.error('Error:', error);
        } finally {
            openProxyBtn.disabled = false;
            openProxyBtn.textContent = 'Open in Proxy Frame';
        }
    });
    
    closeFrameBtn.addEventListener('click', () => {
        proxyFrame.classList.add('hidden');
        proxyIframe.src = '';
        currentUrl.textContent = '';
    });
    
    urlInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            openDirectBtn.click();
        }
    });
    
    const exampleUrls = [
        'example.com',
        'wikipedia.org',
        'archive.org'
    ];
    
    let placeholderIndex = 0;
    setInterval(() => {
        if (!urlInput.value) {
            placeholderIndex = (placeholderIndex + 1) % exampleUrls.length;
            urlInput.placeholder = `Enter URL (e.g., ${exampleUrls[placeholderIndex]})`;
        }
    }, 3000);
});