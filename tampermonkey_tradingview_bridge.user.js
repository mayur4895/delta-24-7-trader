// ==UserScript==
// @name         TradingView Free Alert to Delta Bridge Forwarder
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Intercepts TradingView Free Plan on-screen pop-up alerts and forwards JSON payloads directly to local Delta Bridge!
// @author       Antigravity
// @match        https://www.tradingview.com/chart/*
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(function() {
    'use strict';

    console.log('[Delta TV Forwarder] Userscript active. Watching for free on-screen alerts...');

    const BRIDGE_WEBHOOK_URL = 'http://localhost:5000/webhook';

    // Hook into HTML5 Notification or DOM mutation
    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType === 1) {
                    // Check for TradingView alert toast / notification popup classes
                    const alertContent = node.querySelector('[class*="toast-message"], [class*="alert-toast"], [data-name="toast-message"]') || node;
                    const text = alertContent.innerText || alertContent.textContent || '';

                    if (text.includes('"symbol"') && (text.includes('"BUY"') || text.includes('"SELL"'))) {
                        try {
                            const jsonMatch = text.match(/\{[\s\S]*\}/);
                            if (jsonMatch) {
                                const payload = JSON.parse(jsonMatch[0]);
                                console.log('[Delta TV Forwarder] Captured Alert:', payload);
                                forwardAlert(payload);
                            }
                        } catch (e) {
                            console.warn('[Delta TV Forwarder] Non-JSON popup detected:', text);
                        }
                    }
                }
            }
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    function forwardAlert(payload) {
        GM_xmlhttpRequest({
            method: 'POST',
            url: BRIDGE_WEBHOOK_URL,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify(payload),
            onload: function(response) {
                console.log('[Delta TV Forwarder] Dispatched to Delta Bridge:', response.responseText);
            },
            onerror: function(err) {
                console.error('[Delta TV Forwarder] Failed to connect to local Delta Bridge:', err);
            }
        });
    }
})();
