import { parentPort, workerData } from "node:worker_threads";
import { validateWorkflowSchema } from "./schema.mjs";

try {
	const result = validateWorkflowSchema(workerData.schema, workerData.value);
	parentPort.postMessage({ ok: true, result });
} catch (error) {
	parentPort.postMessage({ ok: false, error: { code: error?.code, message: error?.message ?? String(error) } });
}
