import { definePipeline, node } from "../../../src/pipeline/index.ts";
import { verifyHandler } from "./handlers/verify.ts";

const designPrompt = await Bun.file(new URL("./prompts/design.md", import.meta.url)).text();
const implementPrompt = await Bun.file(new URL("./prompts/implement.md", import.meta.url)).text();

/**
 * Example TypeScript Pipeline Template.
 * Demonstrates `definePipeline`, `defineHandler`, and all four `node.*` constructors:
 * `node.agent`, `node.code`, `node.human`, and `node.end`.
 */
export default definePipeline({
  id: "feature-delivery",
  name: "Feature Delivery",
  description:
    "Minimal example pipeline showing design, implementation, typed TS verification, human approval, and completion.",
  enabled: true,
  nodes: [
    node.agent({
      id: "design",
      name: "Design",
      prompt: designPrompt,
      gate: "manual",
      concurrency: 2,
    }),
    node.agent({
      id: "implement",
      name: "Implement",
      prompt: implementPrompt,
      gate: "auto",
      concurrency: 2,
      allowPrev: true,
      prevTargets: ["design"],
    }),
    node.code({
      id: "verify",
      name: "Verify",
      handler: verifyHandler,
      concurrency: 4,
      allowPrev: true,
      prevTargets: ["implement"],
    }),
    node.human({
      id: "approve",
      name: "Approve",
      allowPrev: true,
      prevTargets: ["implement"],
    }),
    node.end({
      id: "done",
      name: "Done",
    }),
  ],
});
