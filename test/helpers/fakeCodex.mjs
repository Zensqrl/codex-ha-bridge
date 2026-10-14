import readline from "node:readline";
process.on("SIGTERM", () => {}); // Exercise forced cleanup of a stuck native child.
const input = readline.createInterface({ input: process.stdin });
input.on("line", line => {
  const request = JSON.parse(line);
  if (request.method === "initialize") process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\n");
  // Deliberately never answer account/read.
});
