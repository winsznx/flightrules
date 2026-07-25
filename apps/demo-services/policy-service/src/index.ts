import process from "node:process";
import { buildPolicyService } from "./app.js";

const port = Number.parseInt(process.env["PORT"] ?? "4101", 10);
const server = buildPolicyService({ logger: process.env["NODE_ENV"] !== "test" });

server.listen({ port, host: "0.0.0.0" }).catch((error: unknown) => {
  server.log.error(error);
  process.exit(1);
});
