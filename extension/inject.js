(function () {
  'use strict';

  // ══════════════════════════════════════════════════════════════════
  //  CONFIGURATION
  // ══════════════════════════════════════════════════════════════════

  // Confirmed via network analysis:
  // POST /api/v1/schedule-group/get-family-ofc-schedule-days → 403 cf-mitigated
  const API_PATTERNS = [
    '/get-family-ofc-schedule-days',
    '/schedule-group/',
    '/get-family-ofc-schedule-months',
    '/get-ofc-schedule-dates',
    '/get-available-slots',
    '/get-appointment-dates',
  ];

  function matchesApi(url) {
    if (!url || typeof url !== 'string') return false;
    const lower = url.toLowerCase();
    return API_PATTERNS.some((p) => lower.includes(p));
  }

  function resolveUrl(url) {
    if (!url) return '';
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    if (url.startsWith('//')) return window.location.protocol + url;
    // Relative URL — resolve against current page origin
    return window.location.origin + (url.startsWith('/') ? '' : '/') + url;
  }

  function isCfMitigated(responseOrXhr) {
    // For fetch Response objects
    if (responseOrXhr.status !== undefined && responseOrXhr.headers) {
      if (responseOrXhr.status === 403) {
        // Check Cloudflare headers
        if (typeof responseOrXhr.headers.get === 'function') {
          const mitigated = responseOrXhr.headers.get('cf-mitigated');
          if (mitigated === 'challenge') return true;
          const server = responseOrXhr.headers.get('server');
          if (server && server.toLowerCase() === 'cloudflare') return true;
          const contentType = responseOrXhr.headers.get('content-type');
          if (contentType && contentType.includes('text/html')) return true;
        }
        // 403 is almost always CF for these API endpoints
        return true;
      }
      if (responseOrXhr.status === 429) return true;
      return false;
    }
    // For XHR objects
    if (responseOrXhr.status !== undefined) {
      const status = responseOrXhr.status;
      if (status === 403 || status === 429) return true;
      const respText = responseOrXhr.responseText || '';
      if (status >= 400 && respText.includes('cf-cloudflare')) return true;
      return false;
    }
    return false;
  }

  // ══════════════════════════════════════════════════════════════════
  //  FETCH OVERRIDE
  // ══════════════════════════════════════════════════════════════════

  const originalFetch = window.fetch.bind(window);

  window.fetch = async function (input, init) {
    const requestUrl =
      typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : '';

    if (!matchesApi(requestUrl)) {
      return originalFetch(input, init);
    }

    // Make the real request
    let response = await originalFetch(input, init);

    // Check if Cloudflare blocked it
    if (!response.ok && isCfMitigated(response)) {
      // Notify content script to auto-open challenge tab
      window.postMessage(
        { type: 'VISA_CF_BLOCK', url: resolveUrl(requestUrl) },
        '*'
      );

      // Wait for user to solve the challenge
      await new Promise((resolve) => {
        function listener(event) {
          if (event.data && event.data.type === 'VISA_CONTINUE_REQUEST') {
            window.removeEventListener('message', listener);
            resolve();
          }
        }
        window.addEventListener('message', listener);
      });

      // Retry the request with fresh cf_clearance
      response = await originalFetch(input, init);
    }

    return response;
  };

  // ══════════════════════════════════════════════════════════════════
  //  XMLHttpRequest OVERRIDE
  // ══════════════════════════════════════════════════════════════════

  const OrigXHR = window.XMLHttpRequest;
  const OrigOpen = OrigXHR.prototype.open;
  const OrigSend = OrigXHR.prototype.send;
  const OrigSetRequestHeader = OrigXHR.prototype.setRequestHeader;

  OrigXHR.prototype.open = function (method, url, asyncFlag) {
    this._xhrUrl = typeof url === 'string' ? url : String(url);
    this._xhrMethod = method;
    this._xhrAsync = asyncFlag !== false;
    // Store headers
    this._xhrHeaders = {};
    return OrigOpen.apply(this, arguments);
  };

  OrigXHR.prototype.setRequestHeader = function (name, value) {
    if (this._xhrHeaders) {
      this._xhrHeaders[name] = value;
    }
    return OrigSetRequestHeader.apply(this, arguments);
  };

  // Override send with an async-aware wrapper
  const XHRSendOverride = async function (body) {
    // Not an API call — pass through
    if (!this._xhrUrl || !matchesApi(this._xhrUrl)) {
      return OrigSend.call(this, body);
    }

    // Synchronous XHR — pass through (can't intercept safely)
    if (this._xhrAsync === false) {
      return OrigSend.call(this, body);
    }

    const xhr = this;

    // Step 1: Make a test fetch to check CF status
    try {
      const testResp = await originalFetch(xhr._xhrUrl, {
        method: xhr._xhrMethod || 'GET',
        headers: { ...(xhr._xhrHeaders || {}) },
      });

      if (!testResp.ok && isCfMitigated(testResp)) {
        // CF is blocking — auto-open challenge tab, wait for solve
        window.postMessage(
          { type: 'VISA_CF_BLOCK', url: resolveUrl(xhr._xhrUrl) },
          '*'
        );

        await new Promise((resolve) => {
          function listener(event) {
            if (
              event.data &&
              event.data.type === 'VISA_CONTINUE_REQUEST'
            ) {
              window.removeEventListener('message', listener);
              resolve();
            }
          }
          window.addEventListener('message', listener);
        });
      }
    } catch (_) {
      // Test request failed — just proceed with normal send
    }

    // Step 2: Now make the real XHR request
    return OrigSend.call(xhr, body);
  };

  OrigXHR.prototype.send = function (body) {
    // Call our async wrapper but don't await it — XHR is event-driven
    XHRSendOverride.call(this, body);
  };
})();
