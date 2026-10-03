const packageUrl = new URL('../../package.json', import.meta.url).href
let realSharedState = false

export function initialize(options = {}) {
  realSharedState = options.realSharedState === true
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('/dependence/dependencies.js') || specifier === '../dependence/dependencies.js') {
    const source = `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(packageUrl)}); export const dependencies = { axios: require('axios'), moment: require('moment') };`
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
  }
  if (specifier.endsWith('/utils/fileUtils.js') || specifier === './fileUtils.js' || specifier === '../utils/fileUtils.js') {
    const source = 'export const refreshTencentImageUrl = async value => value; export const TakeImages = async e => e._testImages || [];'
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
  }
  if (!realSharedState && (specifier.endsWith('/core/sharedState.js') || specifier === '../core/sharedState.js' || specifier === './sharedState.js')) {
    const source = 'export const initializeSharedState = () => ({}); export const getSharedState = () => null; export const refreshLocalTools = async () => ({}); export const applyToolRegistrySnapshot = () => {};'
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
  }
  if (realSharedState && specifier.endsWith('/LocalToolRegistry.js')) {
    const source = 'const snapshot = { toolInstances: {}, functions: [], functionMap: new Map() }; export const localToolRegistry = { getSnapshot: () => snapshot, reload: async () => snapshot };'
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
