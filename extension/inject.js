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
  //  FETCH OVERRIDE — with retry loop
  // ══════════════════════════════════════════════════════════════════
  //  Retries up to MAX_RETRIES times after solving. The first block
  //  triggers the CF solve tab; subsequent retries wait silently.
  // ══════════════════════════════════════════════════════════════════

  const originalFetch = window.fetch.bind(window);
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 500;

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

    let response = await originalFetch(input, init);
    let retries = 0;

    while (!response.ok && isCfMitigated(response) && retries < MAX_RETRIES) {
      if (retries === 0) {
        // First block: notify content script to open challenge tab
        window.postMessage(
          { type: 'VISA_CF_BLOCK', url: resolveUrl(requestUrl) },
          '*'
        );

        // Wait for solve signal or license abort
        const waitResult = await new Promise((resolve) => {
          function listener(event) {
            if (event.data && event.data.type === 'VISA_CONTINUE_REQUEST') {
              window.removeEventListener('message', listener);
              resolve('continue');
            }
            if (event.data && event.data.type === 'VISA_LICENSE_FAILED') {
              window.removeEventListener('message', listener);
              resolve('abort');
            }
          }
          window.addEventListener('message', listener);
        });

        if (waitResult === 'abort') {
          // License invalid — return the original blocked response
          return response;
        }

        // Brief delay for cookie propagation
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      } else {
        // Subsequent retries: just wait (cf_clearance should exist now)
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * retries));
      }

      response = await originalFetch(input, init);
      retries++;
    }

    return response;
  };

  // ══════════════════════════════════════════════════════════════════
  //  XMLHttpRequest OVERRIDE — proper response monitoring
  // ══════════════════════════════════════════════════════════════════
  //  Instead of a test-fetch (which misses the request body), this
  //  intercept fires AFTER the real XHR completes with a 403/429,
  //  waits for the CF solve, then retries with a brand-new XHR.
  // ══════════════════════════════════════════════════════════════════

  const OrigXHR = window.XMLHttpRequest;
  const OrigOpen = OrigXHR.prototype.open;
  const OrigSend = OrigXHR.prototype.send;
  const OrigSetRequestHeader = OrigXHR.prototype.setRequestHeader;

  OrigXHR.prototype.open = function (method, url, asyncFlag, user, password) {
    // Store request info for later use
    this._xhrInfo = {
      method: method,
      url: typeof url === 'string' ? url : String(url),
      async: asyncFlag !== false,
      user: user,
      password: password,
    };
    this._xhrHeaders = {};
    this._xhrBody = null;
    this._xhrOrigHandlers = {};
    this._xhrSkipIntercept = false;
    return OrigOpen.apply(this, arguments);
  };

  OrigXHR.prototype.setRequestHeader = function (name, value) {
    if (this._xhrHeaders) {
      this._xhrHeaders[name] = value;
    }
    return OrigSetRequestHeader.apply(this, arguments);
  };

  OrigXHR.prototype.send = function (body) {
    const info = this._xhrInfo;
    if (
      !info ||
      !matchesApi(info.url) ||
      info.async === false ||
      this._xhrSkipIntercept
    ) {
      return OrigSend.call(this, body);
    }

    const xhr = this;
    xhr._xhrBody = body;

    // Store original handlers set via onload/onerror/onreadystatechange
    const origOnLoad = xhr.onload;
    const origOnError = xhr.onerror;
    const origOnReadyState = xhr.onreadystatechange;

    // Clear them — we'll fire them manually after our intercept checks
    xhr.onload = null;
    xhr.onerror = null;
    xhr.onreadystatechange = null;

    // Use addEventListener for reliable interception
    xhr.addEventListener('readystatechange', function onReady() {
      if (xhr.readyState !== 4) {
        // Forward intermediate state to original handler
        if (origOnReadyState) origOnReadyState.call(xhr);
        return;
      }

      xhr.removeEventListener('readystatechange', onReady);

      if (isCfMitigated(xhr)) {
        // CF blocked — intercept and retry
        interceptXhrResponse(xhr, {
          onload: origOnLoad,
          onerror: origOnError,
          onreadystatechange: origOnReadyState,
        });
        return;
      }

      // Not blocked — forward to original handlers
      if (origOnReadyState) origOnReadyState.call(xhr);
      if (origOnLoad) origOnLoad.call(xhr);
    });

    xhr.addEventListener('error', function () {
      if (origOnError) origOnError.call(xhr);
    });

    return OrigSend.call(xhr, body);
  };

  // ── XHR retry helper (separated so it can be async) ───────────────

  async function interceptXhrResponse(origXhr, handlers) {
    const url = resolveUrl(origXhr._xhrInfo.url);

    // Notify content script to open CF challenge tab
    window.postMessage({ type: 'VISA_CF_BLOCK', url }, '*');

    // Wait for solve signal or license abort
    const waitResult = await new Promise((resolve) => {
      const listener = (event) => {
        if (event.data && event.data.type === 'VISA_CONTINUE_REQUEST') {
          window.removeEventListener('message', listener);
          resolve('continue');
        }
        if (event.data && event.data.type === 'VISA_LICENSE_FAILED') {
          window.removeEventListener('message', listener);
          resolve('abort');
        }
      };
      window.addEventListener('message', listener);
    });

    if (waitResult === 'abort') {
      // License invalid — fire original handlers with the original 403 response
      // so the page shows the PSE error as if the extension wasn't there
      if (handlers.onreadystatechange) handlers.onreadystatechange.call(origXhr);
      if (handlers.onload) handlers.onload.call(origXhr);
      return;
    }

    // Brief delay for cookie propagation
    await new Promise((r) => setTimeout(r, 500));

    // Retry with a fresh XHR — mark to prevent re-interception
    // IMPORTANT: set _xhrSkipIntercept AFTER open() because
    // open() initializes it to false.
    const retryXhr = new OrigXHR();
    retryXhr.open(
      origXhr._xhrInfo.method,
      origXhr._xhrInfo.url,
      true
    );
    retryXhr._xhrSkipIntercept = true;
    Object.entries(origXhr._xhrHeaders || {}).forEach(([k, v]) =>
      retryXhr.setRequestHeader(k, v)
    );
    retryXhr.onload = handlers.onload;
    retryXhr.onerror = handlers.onerror;
    retryXhr.onreadystatechange = handlers.onreadystatechange;
    retryXhr.send(origXhr._xhrBody);
  }
})();
