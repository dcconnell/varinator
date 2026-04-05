import * as vscode from 'vscode';

/**
 * Resolves C# variable types by communicating with OmniSharp/Roslyn
 * through the VS Code C# extension's language server.
 */
export interface VariableInfo {
    name: string;
    typeName: string;          // Full type name e.g. "List<string>"
    outerTypeName: string;     // Outer type name e.g. "List"
    locations: vscode.Range[]; // All locations of this variable in the document
}

export class TypeResolver {
    /**
     * Resolve the type for a symbol at a given position using the hover provider
     * (OmniSharp exposes type info through hover).
     */
    async getTypeAtPosition(
        document: vscode.TextDocument,
        position: vscode.Position
    ): Promise<string | undefined> {
        try {
            const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
                'vscode.executeHoverProvider',
                document.uri,
                position
            );

            if (!hovers || hovers.length === 0) {
                return undefined;
            }

            for (const hover of hovers) {
                for (const content of hover.contents) {
                    const text = typeof content === 'string'
                        ? content
                        : (content as vscode.MarkdownString).value;

                    const typeName = this.extractTypeFromHover(text);
                    if (typeName) {
                        return typeName;
                    }
                }
            }

            return undefined;
        } catch {
            return undefined;
        }
    }

    /**
     * Find all variables and their inferred types in a document.
     * Uses a two-pass approach:
     * 1. Find variable declarations via regex
     * 2. Resolve each variable's type via OmniSharp hover
     * 3. Find all usages of each variable via document highlights
     */
    async resolveVariablesInDocument(
        document: vscode.TextDocument
    ): Promise<VariableInfo[]> {
        const text = document.getText();
        const variables: VariableInfo[] = [];
        const seenVariables = new Map<string, VariableInfo>();

        // Find variable declarations
        const declarationPositions = this.findDeclarations(text, document);

        // Batch resolve types - process declarations sequentially to avoid
        // overwhelming the language server
        for (const decl of declarationPositions) {
            if (seenVariables.has(decl.scopeKey)) {
                continue;
            }

            const typeName = await this.getTypeAtPosition(document, decl.namePosition);
            if (!typeName) {
                continue;
            }

            // Find all usages of this variable in the document
            const locations = await this.findAllUsages(
                document,
                decl.namePosition,
                decl.name
            );

            const info: VariableInfo = {
                name: decl.name,
                typeName: typeName,
                outerTypeName: this.extractOuterType(typeName),
                locations: locations
            };

            seenVariables.set(decl.scopeKey, info);
            variables.push(info);
        }

        return variables;
    }

    /**
     * Parse hover text from OmniSharp to extract the type name.
     * OmniSharp hover typically returns something like:
     *   ```csharp
     *   (local variable) List<string> myVar
     *   ```
     * or:
     *   ```csharp
     *   int MyClass.myField
     *   ```
     */
    private extractTypeFromHover(hoverText: string): string | undefined {
        // Remove markdown code blocks
        const cleaned = hoverText
            .replace(/```csharp\n?/g, '')
            .replace(/```\n?/g, '')
            .trim();

        // Pattern: (local variable) Type varName
        const localVarMatch = cleaned.match(
            /\(local variable\)\s+(.+?)\s+\S+\s*$/m
        );
        if (localVarMatch) {
            return this.normalizeTypeName(localVarMatch[1]);
        }

        // Pattern: (parameter) Type paramName
        const paramMatch = cleaned.match(
            /\(parameter\)\s+(.+?)\s+\S+\s*$/m
        );
        if (paramMatch) {
            return this.normalizeTypeName(paramMatch[1]);
        }

        // Pattern: (field) Type ClassName.fieldName
        const fieldMatch = cleaned.match(
            /\(field\)\s+(.+?)\s+\S+\.\S+\s*$/m
        );
        if (fieldMatch) {
            return this.normalizeTypeName(fieldMatch[1]);
        }

        // Pattern: (property) Type ClassName.propName
        const propMatch = cleaned.match(
            /\(property\)\s+(.+?)\s+\S+\.\S+/m
        );
        if (propMatch) {
            return this.normalizeTypeName(propMatch[1]);
        }

        // Pattern: Type ClassName.memberName (for other members)
        const memberMatch = cleaned.match(
            /^(.+?)\s+\S+\.\S+\s*$/m
        );
        if (memberMatch && !memberMatch[1].includes('(')) {
            return this.normalizeTypeName(memberMatch[1]);
        }

        return undefined;
    }

    /**
     * Normalize type names - convert fully qualified names to short names,
     * handle nullable types, etc.
     */
    private normalizeTypeName(typeName: string): string {
        let normalized = typeName.trim();

        // Remove nullable ? suffix and track it
        const isNullable = normalized.endsWith('?');
        if (isNullable) {
            normalized = normalized.slice(0, -1);
        }

        // Convert System.Collections.Generic.List<T> -> List<T>
        // Keep only the simple type name
        normalized = normalized.replace(
            /(?:[\w.]+\.)?(\w+)(<[^>]*>)?/g,
            (_, name, generic) => {
                if (generic) {
                    // Also simplify generic type arguments
                    const simplifiedGeneric = generic.replace(
                        /(?:[\w.]+\.)?(\w+)/g,
                        '$1'
                    );
                    return name + simplifiedGeneric;
                }
                return name;
            }
        );

        return normalized;
    }

    /**
     * Extract the outer type name from a generic type.
     * e.g. "List<string>" -> "List", "Dictionary<string, int>" -> "Dictionary"
     */
    private extractOuterType(typeName: string): string {
        const match = typeName.match(/^(\w+)/);
        return match ? match[1] : typeName;
    }

    /**
     * Find variable declaration positions in the document using regex.
     */
    private findDeclarations(
        text: string,
        document: vscode.TextDocument
    ): Array<{ name: string; namePosition: vscode.Position; scopeKey: string }> {
        const results: Array<{
            name: string;
            namePosition: vscode.Position;
            scopeKey: string;
        }> = [];

        // Patterns for C# variable declarations:
        // Type varName =
        // Type varName;
        // var varName =
        // Type varName,
        // foreach (Type varName in ...)
        // using (Type varName = ...)
        // out Type varName
        // Type? varName

        const patterns = [
            // Standard declarations: Type varName = / ; / ,
            // Matches: int x = 5; List<string> items = new(); var y = GetValue();
            /(?:^|[\s{(,;])(?:(?:readonly|static|const|volatile)\s+)*(?:(?:var|[\w.<>,\[\]?]+)\s+)(\w+)\s*(?=[=;,)\]])/gm,

            // foreach: foreach (Type varName in ...)
            /foreach\s*\(\s*(?:var|[\w.<>,\[\]?]+)\s+(\w+)\s+in\b/gm,

            // using declaration: using Type varName =
            /using\s+(?:var|[\w.<>,\[\]?]+)\s+(\w+)\s*=/gm,

            // out variable: out Type varName
            /\bout\s+(?:var|[\w.<>,\[\]?]+)\s+(\w+)\b/gm,

            // Pattern/deconstruction variable declaration
            /\bis\s+(?:var|[\w.<>,\[\]?]+)\s+(\w+)\b/gm,

            // Method parameters (in method signatures)
            /(?:^|[,(])\s*(?:(?:this|ref|in|out|params)\s+)?(?:[\w.<>,\[\]?]+)\s+(\w+)\s*(?=[,)=])/gm,
        ];

        // C# keywords to exclude from variable name matches
        const keywords = new Set([
            'abstract', 'as', 'base', 'bool', 'break', 'byte', 'case', 'catch',
            'char', 'checked', 'class', 'const', 'continue', 'decimal', 'default',
            'delegate', 'do', 'double', 'else', 'enum', 'event', 'explicit',
            'extern', 'false', 'finally', 'fixed', 'float', 'for', 'foreach',
            'goto', 'if', 'implicit', 'in', 'int', 'interface', 'internal',
            'is', 'lock', 'long', 'namespace', 'new', 'null', 'object',
            'operator', 'out', 'override', 'params', 'private', 'protected',
            'public', 'readonly', 'ref', 'return', 'sbyte', 'sealed', 'short',
            'sizeof', 'stackalloc', 'static', 'string', 'struct', 'switch',
            'this', 'throw', 'true', 'try', 'typeof', 'uint', 'ulong',
            'unchecked', 'unsafe', 'ushort', 'using', 'var', 'virtual', 'void',
            'volatile', 'while', 'yield', 'async', 'await', 'dynamic', 'get',
            'set', 'add', 'remove', 'value', 'partial', 'where', 'record',
            'init', 'required', 'global', 'file', 'scoped', 'notnull',
            'unmanaged', 'managed', 'nint', 'nuint'
        ]);

        for (const pattern of patterns) {
            let match: RegExpExecArray | null;
            while ((match = pattern.exec(text)) !== null) {
                const varName = match[1];
                if (!varName || keywords.has(varName)) {
                    continue;
                }

                // Get the position of the variable name within the match
                const fullMatchIndex = match.index;
                const varNameIndex = text.indexOf(varName, fullMatchIndex + match[0].indexOf(varName));
                const position = document.positionAt(varNameIndex);

                // Create a scope key from line context to deduplicate
                const lineNum = position.line;
                const scopeKey = `${varName}@L${lineNum}`;

                results.push({
                    name: varName,
                    namePosition: position,
                    scopeKey
                });
            }
        }

        return results;
    }

    /**
     * Find all usages of a variable in the document using the document highlight provider.
     * Falls back to text search if the provider is unavailable.
     */
    private async findAllUsages(
        document: vscode.TextDocument,
        declarationPos: vscode.Position,
        varName: string
    ): Promise<vscode.Range[]> {
        try {
            // Use document highlights (semantic - from OmniSharp)
            const highlights = await vscode.commands.executeCommand<vscode.DocumentHighlight[]>(
                'vscode.executeDocumentHighlights',
                document.uri,
                declarationPos
            );

            if (highlights && highlights.length > 0) {
                return highlights.map(h => h.range);
            }
        } catch {
            // Fall through to text search
        }

        // Fallback: text-based search for the variable name
        return this.findTextOccurrences(document, varName);
    }

    /**
     * Fallback: find all word-boundary occurrences of a name in the document.
     */
    private findTextOccurrences(
        document: vscode.TextDocument,
        name: string
    ): vscode.Range[] {
        const ranges: vscode.Range[] = [];
        const text = document.getText();
        const regex = new RegExp(`\\b${this.escapeRegex(name)}\\b`, 'g');

        let match: RegExpExecArray | null;
        while ((match = regex.exec(text)) !== null) {
            const startPos = document.positionAt(match.index);
            const endPos = document.positionAt(match.index + name.length);
            ranges.push(new vscode.Range(startPos, endPos));
        }

        return ranges;
    }

    private escapeRegex(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
}
