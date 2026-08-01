// Throws while rendering — the popup shows, but is missing the element tests look for.
console.error('popup failed to initialise');
document.getElementById('does-not-exist').textContent = 'boom';
