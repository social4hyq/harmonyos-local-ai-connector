const STATUS_TEXT = {
  connected: '已连接',
  disconnected: '已断开',
  reconnecting: '重连中...',
};

function update() {
  chrome.storage.local.get(['connectionState', 'requestCount'], (data) => {
    const state = data.connectionState || 'disconnected';
    const count = data.requestCount || 0;

    const dot = document.getElementById('dot');
    dot.className = 'dot ' + state;

    document.getElementById('status-text').textContent = STATUS_TEXT[state] || state;
    document.getElementById('count').textContent = count;
  });
}

update();
// Refresh every 2 seconds while popup is open
setInterval(update, 2000);
