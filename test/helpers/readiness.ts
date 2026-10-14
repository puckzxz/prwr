import net from "node:net";

export async function listen(server: net.Server, port = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => reject(error);
    server.once("error", failed);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", failed);
      resolve();
    });
  });
  return (server.address() as net.AddressInfo).port;
}

export async function unusedPort(): Promise<number> {
  const server = net.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

export function trackConnections(server: net.Server): Set<net.Socket> {
  const sockets = new Set<net.Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return sockets;
}

export async function close(server: net.Server, sockets = new Set<net.Socket>()): Promise<void> {
  for (const socket of sockets) socket.destroy();
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
}
