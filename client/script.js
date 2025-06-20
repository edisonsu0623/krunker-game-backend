const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
canvas.width = window.innerWidth;
canvas.height = window.innerHeight;

const playerId = Math.random().toString(36).substring(2, 9);
const players = {};
let x = Math.random() * canvas.width;
let y = Math.random() * canvas.height;

const socket = new WebSocket(`wss://${window.location.host}/api/socket`);
socket.onmessage = event => {
  const data = JSON.parse(event.data);
  players[data.id] = data;
};

socket.onclose = () => alert("Server disconnected");

function sendPosition() {
  socket.send(JSON.stringify({ id: playerId, x, y }));
}

function drawPlayers() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const id in players) {
    const p = players[id];
    ctx.fillStyle = p.id === playerId ? "lime" : "white";
    ctx.fillRect(p.x, p.y, 20, 20);
  }
}

document.addEventListener('keydown', e => {
  if (e.key === 'ArrowUp') y -= 10;
  if (e.key === 'ArrowDown') y += 10;
  if (e.key === 'ArrowLeft') x -= 10;
  if (e.key === 'ArrowRight') x += 10;
  sendPosition();
});

setInterval(drawPlayers, 1000 / 30);
sendPosition();