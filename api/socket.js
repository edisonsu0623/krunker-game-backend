import { Server } from 'ws';

let clients = [];

export default function handler(req, res) {
  if (res.socket.server.wss) {
    console.log('WebSocket server already running');
    res.end();
    return;
  }

  const wss = new Server({ noServer: true });
  res.socket.server.wss = wss;

  res.socket.server.on('upgrade', (req, socket, head) => {
    if (req.url === '/api/socket') {
      wss.handleUpgrade(req, socket, head, ws => {
        wss.emit('connection', ws, req);
      });
    }
  });

  wss.on('connection', ws => {
    clients.push(ws);
    ws.on('message', msg => {
      for (const client of clients) {
        if (client.readyState === 1) {
          client.send(msg);
        }
      }
    });
    ws.on('close', () => {
      clients = clients.filter(c => c !== ws);
    });
  });

  console.log('WebSocket server started');
  res.end();
}