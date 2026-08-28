export {
  attachInternalToolBatchLifecycle,
  attachInternalToolExecutionPreparer,
  copyInternalToolExecutionPreparer,
  getInternalToolExecutionPreparer,
  setInternalBeforeToolBatch,
  type InternalBeforeToolBatchHook,
  type InternalToolExecutionPreparer,
} from "../../../packages/agent-core/src/internal-hooks.js";
export { isTurnHandoffAbort } from "../../../packages/agent-core/src/turn-interruption.js";
