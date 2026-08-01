const marker = document.createElement('div');
marker.id = 'content-only-marker';
marker.textContent = 'content-only extension injected';
(document.body ?? document.documentElement).appendChild(marker);
