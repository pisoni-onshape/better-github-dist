/** gm_polyfill.js
 * Author: Piyush Soni
 * A compatibility layer for common TamperMonkey GM_ API functions
 * to Chrome/Firefox WebExtension APIs
 * Mostly so that I can maintain a single source of
 * better-github.user.js and use it either as part of
 * the extension, or a plain and simple userscript.
 * */

// Make sure it works for both Chrome and Firefox.
const browserAPI = typeof chrome !== 'undefined' ? chrome : (typeof browser !== 'undefined' ? browser : null);

if (!browserAPI) {
  console.error("GM_Polyfill: Neither 'chrome' nor 'browser' API found. Polyfill will not function.");
}

if (typeof GM === 'undefined') {
    window.GM = {};
}

// PS ToDo : Write async forms of GM_setValue and GM_getValue and use them
// in the script userscript-config properly.

window.GM_addStyle = function(css) {
  const style = document.createElement('style');
  style.type = 'text/css';
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);
};

window.GM_getResourceURL = function(resourceName) {
  if (!browserAPI || !browserAPI.runtime || !browserAPI.runtime.getURL) {
    console.error("GM_getResourceURL: runtime.getURL API not available.");
    return null;
  }
  return browserAPI.runtime.getURL("resources/" + resourceName);
};


window.GM.xmlHttpRequest = function(details) {
    browserAPI.runtime.sendMessage({
        type: 'GM_xmlHttpRequest',
        details: {
            method: details.method || 'GET',
            url: details.url,
            headers: details.headers || {},
            data: details.data
        }
    }, function(response) {
        const lastError = browserAPI.runtime.lastError;
        if (lastError) {
            if (details.onerror) {
                details.onerror({
                    status: 0,
                    statusText: lastError.message,
                    responseText: '',
                    error: lastError.message
                });
            }
            return;
        }

        if (response.error && details.onerror) {
            details.onerror(response);
        } else if (response.status >= 200 && response.status < 300 && details.onload) {
            details.onload(response);
        } else if (details.onerror) {
            details.onerror(response);
        } else if (details.onload) {
            // GM.xmlHttpRequest calls onload even for HTTP errors
            details.onload(response);
        }
    });
};

// In case the older form is used
window.GM_xmlhttpRequest = GM.xmlHttpRequest;
