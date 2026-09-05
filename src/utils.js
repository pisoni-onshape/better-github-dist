// Utility functions

function isMacOS() {
    return navigator.platform.indexOf('Mac') > -1;
}

/**
 * Fires the 'click' event on the given HTMLElement node
 * @param {HTMLElement} element The node on which to simulate triggering the click event
 * */
function fireClickEvent(element) {
    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
    element.dispatchEvent(clickEvent);
}

/**
 * Returns a promise that resolves when the element with the given query selector
 * is present (either immediately or later). The observer stops listening after
 * that.
 * @param {string} selector
 */
function waitForElement(selector) {
    return new Promise(resolve => {
        if (document.querySelector(selector)) {
            return resolve(document.querySelector(selector));
        }

        const observer = new MutationObserver(mutations => {
            if (document.querySelector(selector)) {
                observer.disconnect();
                resolve(document.querySelector(selector));
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    });
}

/**
 * Observes a target DOM node for the addition of new elements matching a specific CSS selector. A little lengthy,
 * but I think it's as performant as it can get right now for this purpose ...
 * @param {HTMLElement} targetNode The DOM node to observe for changes. This can be document.body or any other element.
 * @param {string} selector The CSS selector string (e.g., '.my-class', 'div.item', '#myId') to look for among newly added elements.
 * @param {function(HTMLElement): void} callback The function to call when a matching element is found. It receives the HTMLElement as an argument.
 * @param {boolean} [stopOnFirstFind=false] If true, the observer will stop after the first matching element is found and the callback is fired.
 * @returns {MutationObserver|null} The MutationObserver instance if observation starts, or null if element is found immediately and stopOnFirstFind is true.
 */
function onNewElement(targetNode, selector, callback, stopOnFirstFind = false) {
    if (!(targetNode instanceof HTMLElement)) {
        // Could be a common mistake. This is not supposed to be a selector.
        console.error('Invalid targetNode provided. Must be an HTMLElement.');
        return null;
    }

    // Check if the element already exists if stopOnFirstFind is true
    // (no need to create the MutationObserver in that case)
    let existingElement = undefined;
    if (stopOnFirstFind && (existingElement = targetNode.querySelector(selector))) {
        callback(existingElement);
        return null; // no observer created
    }

    const observerConfig = {
        childList: true,
        subtree: true
    };

    const observer = new MutationObserver((mutationsList, observerInstance) => {
        for (const mutation of mutationsList) {
            if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                for (const node of mutation.addedNodes) {
                    // Only process element nodes
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        // One of the added nodes itself matches the selector?
                        if (node.matches(selector)) {
                            callback(node);
                            if (stopOnFirstFind) {
                                observerInstance.disconnect();
                                return;
                            }
                        }

                        // Check if any descendants of the added node match the selector
                        // This handles cases where a large HTML chunk is added
                        if (stopOnFirstFind) {
                            const matchingDescendant = node.querySelector(selector);
                            if (matchingDescendant) {
                                callback(matchingDescendant);
                                observerInstance.disconnect();
                                return;
                            }
                        } else {
                            const matchingDescendants = node.querySelectorAll(selector);
                            matchingDescendants.forEach(descendant => {
                                callback(descendant);
                            });
                        }

                    }
                }
            }
            // If stopOnFirstFind was true and we've disconnected, ensure no more callbacks are called
            if (stopOnFirstFind && !observerInstance.takeRecords().length) {
                 return;
            }
        }
    });

    observer.observe(targetNode, observerConfig);
    console.log(`MutationObserver started observing for '${selector}' within`, targetNode);

    return observer;
}

window.isMacOS = isMacOS;
window.fireClickEvent = fireClickEvent;
window.waitForElement = waitForElement;
window.onNewElement = onNewElement;
