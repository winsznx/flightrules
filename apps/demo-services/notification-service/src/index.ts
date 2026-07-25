import process from "node:process";
import { buildNotificationService } from "./app.js";

const port = Number.parseInt(process.env["PORT"] ?? "4105", 10);
const { server } = buildNotificationService({
  demoMode: process.env["DEMO_MODE"] === "true",
  logger: process.env["NODE_ENV"] !== "test",
});

server.listen({ port, host: "0.0.0.0" }).catch((error: unknown) => {
  server.log.error(error);
  process.exit(1);
});
