import { createInterface } from "node:readline";
import { copyFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "./config.js";
import { Store } from "./db.js";
import { passwordHashAsync } from "./crypto.js";

const [action, username] = process.argv.slice(2);
const stdin = async () => {
  const line = createInterface({ input: process.stdin, terminal: false });
  let value = "";
  for await (const part of line) value += part;
  return value.trim();
};
const hiddenPassword = () =>
  new Promise<string>((resolve, reject) => {
    if (!process.stdin.isTTY) return void stdin().then(resolve, reject);
    let value = "";
    process.stdout.write("Password: ");
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const done = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stdout.write("\n");
      resolve(value);
    };
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003") {
          process.stdin.setRawMode(false);
          process.stdout.write("\n");
          reject(new Error("Cancelled"));
          return;
        }
        if (char === "\r" || char === "\n") return done();
        if (char === "\u007f") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    process.stdin.on("data", onData);
  });
const checkBackup = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const result = db.prepare("PRAGMA integrity_check").get() as {
      integrity_check?: string;
    };
    if (result.integrity_check !== "ok")
      throw new Error("Backup integrity check failed");
  } finally {
    db.close();
  }
};

try {
  const config = loadConfig();
  if (action === "bootstrap-admin") {
    if (!username || !/^[a-zA-Z0-9_.-]{3,64}$/.test(username))
      throw new Error("Usage: npm run admin:bootstrap -- <username>");
    const store = new Store(config.databasePath);
    try {
      if (store.admin(username)) throw new Error("Admin already exists");
      const password = await hiddenPassword();
      if (password.length < 14)
        throw new Error("Password must contain at least 14 characters");
      store.createAdmin(username, await passwordHashAsync(password));
      console.log(`Admin ${username} created.`);
    } finally {
      store.close();
    }
  } else if (action === "backup") {
    const destination = process.argv[3];
    if (!destination)
      throw new Error("Usage: npm run db:backup -- <backup-path>");
    const store = new Store(config.databasePath);
    try {
      await store.backup(resolve(destination));
      checkBackup(resolve(destination));
      console.log("Backup complete and verified.");
    } finally {
      store.close();
    }
  } else if (action === "restore") {
    const source = process.argv[3];
    if (!source || !existsSync(source))
      throw new Error("Usage: npm run db:restore -- <verified-backup-path>");
    const input = resolve(source),
      target = config.databasePath,
      temporary = `${target}.restore.tmp`;
    checkBackup(input);
    copyFileSync(input, temporary);
    checkBackup(temporary);
    for (const suffix of ["", "-wal", "-shm"])
      if (existsSync(`${target}${suffix}`)) rmSync(`${target}${suffix}`);
    renameSync(temporary, target);
    console.log(
      "Database restored. Start the gateway after this command exits.",
    );
  } else throw new Error("Supported actions: bootstrap-admin, backup, restore");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Command failed");
  process.exitCode = 1;
}
