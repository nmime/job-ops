import { buildDefaultReactiveResumeDocument } from "../src/server/services/rxresume/document";

const doc = buildDefaultReactiveResumeDocument() as Record<string, unknown>;
const basics = doc.basics as Record<string, unknown>;
basics.name = "Demo User";
basics.headline = "Senior TypeScript Engineer";
basics.email = "demo@example.com";
console.log(Buffer.from(JSON.stringify(doc)).toString("base64"));
