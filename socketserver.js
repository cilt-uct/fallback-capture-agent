const net = require('net');
const clients = [];

net.createServer(socket => {
  clients.push(socket);
  console.log(`number of sockets: ${clients.length}`);
  socket.on('end', () => {
    clients.splice(clients.indexOf(socket), 1);
    console.log(`disconnected: ${clients.length} remaining`);
  });
  socket.on('error', e => {
    clients.splice(clients.indexOf(socket), 1);
    socket.destroy();
    console.log(`socket error so forced disconnection: ${clients.length} remaining`);
  });
}).listen(7890);
