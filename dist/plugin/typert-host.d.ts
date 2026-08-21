export declare const TYPERT: Readonly<{
    package: "dsh-llm-governor";
    face: "host";
    schemas: never[];
    model: {
        services: {
            key: string;
            exportName: string;
            members: {
                kind: "method";
                name: string;
                signature: string;
            }[];
            types: never[];
            description: string;
            tags: never[];
        }[];
        events: never[];
        objects: never[];
    };
    invocations: readonly import("@deepseek-ai/dsh-typert-protocol").InvocationDescriptor[];
}>;
export default TYPERT;
