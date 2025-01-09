import { JinagaServer } from "../jinaga-server";
import { createReadStream } from "fs";
import { createLineReader } from "../http/line-reader";
import { FactEnvelope, verifyEnvelopes } from "jinaga";
import { Pool } from "pg";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

async function importFacts(filePath: string, connectionString: string) {
  const pool = new Pool({
    connectionString,
  });

  const { handler, j, withSession, close } = JinagaServer.create({
    pgStore: pool,
  });

  const readStream = createReadStream(filePath);
  const readLine = createLineReader(readStream);

  const envelopes: FactEnvelope[] = [];
  let line: string | null;
  while ((line = await readLine()) !== null) {
    const envelope: FactEnvelope = JSON.parse(line);
    envelopes.push(envelope);
  }

  if (!verifyEnvelopes(envelopes)) {
    throw new Error("The signatures on the facts are invalid.");
  }

  await j.factManager.save(envelopes);

  await close();
}

const argv = yargs(hideBin(process.argv))
  .option("file", {
    alias: "f",
    type: "string",
    description: "Path to the Factual or JSON export file",
    demandOption: true,
  })
  .option("connection", {
    alias: "c",
    type: "string",
    description: "Postgres connection string",
    demandOption: true,
  })
  .help()
  .alias("help", "h").argv;

importFacts(argv.file, argv.connection)
  .then(() => {
    console.log("Import completed successfully.");
  })
  .catch((error) => {
    console.error("Error during import:", error);
  });
