const runtimeAssignments = new Map();

export function setModelRuntime(target, config) {
  runtimeAssignments.set(target, Object.freeze({ ...config }));
}

export function getModelRuntime(target) {
  return runtimeAssignments.get(target) || null;
}

export function clearModelRuntime(target) {
  if (target) runtimeAssignments.delete(target);
  else runtimeAssignments.clear();
}
