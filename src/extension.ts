import * as vscode from 'vscode';
import { TypeResolver, VariableInfo } from './typeResolver';
import { DecorationManager, HighlightStyle } from './decorationManager';
import { ColorResolver } from './colorResolver';

let typeResolver: TypeResolver;
let decorationManager: DecorationManager;
let colorResolver: ColorResolver;
let enabled = true;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let analysisInProgress = false;
let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext): void {
    typeResolver = new TypeResolver();
    decorationManager = new DecorationManager();
    colorResolver = new ColorResolver();

    // Status bar
    statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100
    );
    statusBarItem.command = 'varinator.toggle';
    updateStatusBar();
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Commands
    context.subscriptions.push(
        vscode.commands.registerCommand('varinator.toggle', () => {
            enabled = !enabled;
            updateStatusBar();
            if (enabled) {
                triggerAnalysis(vscode.window.activeTextEditor);
            } else {
                decorationManager.clearAll();
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('varinator.refresh', () => {
            if (enabled) {
                const editor = vscode.window.activeTextEditor;
                if (editor) {
                    analyzeAndDecorate(editor);
                }
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('varinator.showTypeAtCursor', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.languageId !== 'csharp') {
                vscode.window.showInformationMessage('Varinator: Open a C# file and place your cursor on a variable.');
                return;
            }

            const position = editor.selection.active;
            const typeName = await typeResolver.getTypeAtPosition(editor.document, position);
            if (typeName) {
                const color = colorResolver.getColorForType(typeName, typeName.replace(/<.*>$/, ''));
                const colorInfo = color ? ` (color: ${color})` : ' (no color configured)';
                vscode.window.showInformationMessage(`Varinator: Inferred type is "${typeName}"${colorInfo}`);
            } else {
                vscode.window.showInformationMessage('Varinator: Could not determine type at cursor position.');
            }
        })
    );

    // Active editor change
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (enabled && editor) {
                triggerAnalysis(editor);
            }
        })
    );

    // Document changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(event => {
            if (!enabled) {
                return;
            }
            const editor = vscode.window.activeTextEditor;
            if (editor && event.document === editor.document) {
                triggerAnalysis(editor);
            }
        })
    );

    // Configuration changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('varinator')) {
                colorResolver.loadConfig();

                const config = vscode.workspace.getConfiguration('varinator');
                enabled = config.get<boolean>('enabled', true);
                updateStatusBar();

                // Style change requires cache invalidation
                if (
                    event.affectsConfiguration('varinator.highlightStyle') ||
                    event.affectsConfiguration('varinator.underlineWidth') ||
                    event.affectsConfiguration('varinator.backgroundOpacity')
                ) {
                    decorationManager.invalidateCache();
                }

                if (enabled) {
                    triggerAnalysis(vscode.window.activeTextEditor);
                } else {
                    decorationManager.clearAll();
                }
            }
        })
    );

    // Analyze on activation if a C# file is open
    if (vscode.window.activeTextEditor) {
        // Delay initial analysis to let OmniSharp start up
        setTimeout(() => {
            if (enabled && vscode.window.activeTextEditor) {
                triggerAnalysis(vscode.window.activeTextEditor);
            }
        }, 3000);
    }
}

function updateStatusBar(): void {
    if (enabled) {
        statusBarItem.text = '$(symbol-color) Varinator';
        statusBarItem.tooltip = 'Varinator: Type highlighting enabled (click to toggle)';
    } else {
        statusBarItem.text = '$(circle-slash) Varinator';
        statusBarItem.tooltip = 'Varinator: Type highlighting disabled (click to toggle)';
    }
}

/**
 * Trigger a debounced analysis of the current editor.
 */
function triggerAnalysis(editor: vscode.TextEditor | undefined): void {
    if (!editor || editor.document.languageId !== 'csharp') {
        return;
    }

    if (debounceTimer) {
        clearTimeout(debounceTimer);
    }

    const config = vscode.workspace.getConfiguration('varinator');
    const debounceMs = config.get<number>('debounceMs', 300);

    debounceTimer = setTimeout(() => {
        analyzeAndDecorate(editor);
    }, debounceMs);
}

/**
 * Perform the full analysis: resolve variable types, map to colors, apply decorations.
 */
async function analyzeAndDecorate(editor: vscode.TextEditor): Promise<void> {
    if (analysisInProgress) {
        return; // Don't stack analyses
    }

    analysisInProgress = true;
    statusBarItem.text = '$(loading~spin) Varinator';

    try {
        const variables = await typeResolver.resolveVariablesInDocument(editor.document);

        if (!enabled) {
            return; // User toggled off during analysis
        }

        const config = vscode.workspace.getConfiguration('varinator');
        const style = config.get<HighlightStyle>('highlightStyle', 'foreground');
        const underlineWidth = config.get<string>('underlineWidth', '2px');
        const backgroundOpacity = config.get<number>('backgroundOpacity', 0.15);

        // Group ranges by color
        const rangesByColor = new Map<string, vscode.Range[]>();

        for (const varInfo of variables) {
            const color = colorResolver.getColorForType(
                varInfo.typeName,
                varInfo.outerTypeName
            );

            if (!color) {
                continue;
            }

            const existing = rangesByColor.get(color) ?? [];
            existing.push(...varInfo.locations);
            rangesByColor.set(color, existing);
        }

        // Apply decorations
        decorationManager.applyDecorations(editor, rangesByColor, style, {
            underlineWidth,
            backgroundOpacity
        });
    } catch (err) {
        console.error('Varinator: Error during analysis', err);
    } finally {
        analysisInProgress = false;
        updateStatusBar();
    }
}

export function deactivate(): void {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
    }
    decorationManager.dispose();
}
