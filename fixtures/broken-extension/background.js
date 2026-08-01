// Throws on startup. The worker still registers, but the error should surface in the report.
console.log('broken worker starting');
Promise.reject(new Error('deliberate unhandled rejection from the service worker'));
undefinedFunctionThatDoesNotExist();
