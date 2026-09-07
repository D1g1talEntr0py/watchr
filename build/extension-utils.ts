const fileExtensionPattern = /\.[a-z\d]+$/i;

export const addJavaScriptExtension = (modulePath: string): string => fileExtensionPattern.test(modulePath) ? modulePath : `${modulePath}.js`;
