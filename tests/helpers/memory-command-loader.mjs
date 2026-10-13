export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('/lib/common/common.js')) {
    return { url: 'data:text/javascript,export default {}', shortCircuit: true }
  }
  if (specifier.endsWith('/core/sharedState.js')) {
    return { url: 'data:text/javascript,export const getSharedState = () => globalThis.memoryCommandState', shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
