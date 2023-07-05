import * as vscode from 'vscode';
import { promises as fs } from 'node:fs'
import { PageItem, PageTreeProvider } from './pagetree';

const LOG = vscode.window.createOutputChannel("pdf-tools");
const CONTEXT : any = { sortState : false };
export async function activate(context: vscode.ExtensionContext) {
	CONTEXT.extensionUri = context.extensionUri;
	const pageTreeProvider = new PageTreeProvider([]);
	await pageTreeProvider.initialize();
	const pageTree = vscode.window.createTreeView('pdf-tools', {
		treeDataProvider: pageTreeProvider, 
		showCollapseAll: true,
		canSelectMany: true,
		dragAndDropController: pageTreeProvider
	});
	CONTEXT.pageTree = pageTree;
	CONTEXT.pageTreeProvider = pageTreeProvider;
	vscode.commands.registerCommand('pdf-tools.preview', async(...items: any[]) => {
		showPreview(pageTreeProvider, _getSelected());
	 });
	vscode.commands.registerCommand('pdf-tools.rename', async(...items: any[]) => {
		const newName = await vscode.window.showInputBox({title: "Rename file", value: items[0].label, prompt: "Please enter new name"});
		pageTreeProvider.rename(newName!, _getSelectedOrAll());
	});
	vscode.commands.registerCommand('pdf-tools.renameSelected', async() => {
		const item = _getSelected()[0];
		const newName = await vscode.window.showInputBox({title: "Rename file", value: item.label as string, prompt: "Please enter new name"});
		pageTreeProvider.rename(newName!, [item]);
	});
	vscode.commands.registerCommand('pdf-tools.remove', async(...items: any[]) => { 
		pageTreeProvider.remove(_getSelected());
		await new Promise(resolve => setTimeout(resolve, 1000));
		showPreview(pageTreeProvider, _getSelected());
	});
	vscode.commands.registerCommand('pdf-tools.sort', async() => { 
		CONTEXT.sortState = !CONTEXT.sortState;
		pageTreeProvider.sort(CONTEXT.sortState);
	});
	vscode.commands.registerCommand('pdf-tools.extract', async(...items: any[]) => { 
		const pdfDocument = await pageTreeProvider.pdfFrom(_getSelectedOrAll());
		const pdfBytes = await pdfDocument.save();
		const saveFile = await vscode.window.showSaveDialog({title: "Save to", filters: {'PDF': ['pdf']}, defaultUri: vscode.Uri.file(getOutputDir()) });
		if( saveFile ) {
			await fs.writeFile(saveFile.fsPath, pdfBytes);
			const result = await vscode.window.showInformationMessage("File created successfully at '" + saveFile.fsPath + "'", "OK", "Open");
			if( result === "Open") {
				vscode.env.openExternal(saveFile);
			}
		}
	});
	vscode.commands.registerCommand('pdf-tools.rotate', async(...items: any[]) => { 
		for(const item of _getSelectedOrAll()) {
			const rotation = item.data!.pdfPage.getRotation();
			rotation.angle += 90;
			item.data!.pdfPage.setRotation(rotation);
		}
		showPreview(pageTreeProvider, _getSelectedOrAll());
	});
	vscode.commands.registerCommand('pdf-tools.splitVertical', async(...items: any[]) => { 
		// const newItems = await pageTreeProvider.split("v", _flatten(items));
		const newItems = await pageTreeProvider.split("v", _getSelectedOrAll());
		showPreview(pageTreeProvider, newItems);
	}); 
	vscode.commands.registerCommand('pdf-tools.splitHorizontal', async(...items: any[]) => { 
		const newItems = await pageTreeProvider.split("h", _getSelectedOrAll());
		showPreview(pageTreeProvider, newItems);
	});
	vscode.commands.registerCommand('pdf-tools.combineVertical', async(...items: any[]) => { 
		const newNode = await pageTreeProvider.combine("v", items[1][0], items[1][1]);
		showPreview(pageTreeProvider, [newNode])
	});
	vscode.commands.registerCommand('pdf-tools.combineHorizontal', async(...items: any[]) => { 
		const newNode = await pageTreeProvider.combine("h", items[1][0], items[1][1]);
		showPreview(pageTreeProvider, [newNode])
	});
	vscode.commands.registerCommand('pdf-tools.clear', async(...items: any[]) => { 
		pageTreeProvider.clear();
	});
	vscode.commands.registerCommand('pdf-tools.splitPages', async() => {
		const saveFile = await vscode.window.showSaveDialog({title: "Save to", filters: {'PDF': ['pdf']}, defaultUri: vscode.Uri.file(getOutputDir()) });
		const filePrefix = saveFile?.fsPath.substring(0, saveFile.fsPath.length-4);
		const pages = pageTree.selection.length > 1 ? pageTree.selection : pageTreeProvider.getPageItems();
		const pagesPerDoc = Number(await vscode.window.showInputBox({title: "Split every ... pages:", value: "1", validateInput: (x: string) => isNaN(Number(x)) ? "Enter a number" : undefined }));
		let position = 0;
		let counter = 0;
		while(position < pages.length) {
			const targetPosition = Math.min(pages.length, position+pagesPerDoc);
			const pdfDocument = await pageTreeProvider.pdfFrom(pages.slice(position, targetPosition));
			position = targetPosition;
			const pdfBytes = await pdfDocument.save();
			await fs.writeFile(filePrefix + "_" + ++counter + ".pdf", pdfBytes);
		}
	});
	context.subscriptions.push(pageTree);
	pageTreeProvider.refreshTree();
	pageTree.onDidChangeSelection(async(event) => {
		showPreview(pageTreeProvider, event.selection as PageItem[]);
	});
}

function getOutputDir() {
	return vscode.workspace.getConfiguration('pdf-tools').get("outputDir") as string;
}

// This method is called when your extension is deactivated
export function deactivate() {}

function _flatten(items: any[]){
	return items[1] || [items[0]];
} 

function _getSelectedOrAll() : PageItem[] {
	return CONTEXT.pageTree.selection.length > 0 ? CONTEXT.pageTree.selection : CONTEXT.pageTreeProvider.getPageItems();
}

function _getSelected() : PageItem[] {
	return CONTEXT.pageTree.selection;
}

/** Opens or refreshes the preview for the given items */
async function showPreview(treeProvider: PageTreeProvider, items: any[]) {
	const webview = getWebview(CONTEXT.extensionUri);
	const pdfData = await Promise.all(items.map(async(item: any) => await (await treeProvider.pdfFrom([item], false)).saveAsBase64()));
	webview.html = getWebviewContent(webview, CONTEXT.extensionUri, pdfData);
	await treeProvider.refreshModel();
	treeProvider.refreshTree();
}

function getWebview(extensionUri: vscode.Uri) {
	if( CONTEXT.panel )
	if( CONTEXT.panel ) {
		try { CONTEXT.panel.webview } catch(error) { CONTEXT.panel = null}
	}
	if( !CONTEXT.panel || !CONTEXT.panel.webview) {
		CONTEXT.panel = vscode.window.createWebviewPanel('pdf-tools.preview', 'PDF Preview', vscode.ViewColumn.One, 
			{enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]});
	}
	return CONTEXT.panel.webview;
}

function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri, pdfData: string[]) {
	const scale = 1.0;
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'viewer.css'));
		const cssClass = "previewPanel-" + Math.min(pdfData.length,3);
		return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<link href="${styleUri}" rel="stylesheet">
				<title>PDF Preview</title>
				<script src="https://mozilla.github.io/pdf.js/build/pdf.js"></script>
				</head>
				<body>
				<div id="previewContainer"></div>
				<script type="text/javascript">
				var pdfjsLib = window['pdfjs-dist/build/pdf'];    
				var container = document.getElementById("previewContainer");
				var availablePdfData = ${JSON.stringify(pdfData)};
				(async() => {
					for(var pdfData of availablePdfData) {
						var loadingTask = pdfjsLib.getDocument({data: atob(pdfData)});
						var pdf = await loadingTask.promise;
						var canvas = document.createElement("canvas");
						canvas.classList.add("${cssClass}");
						container.appendChild(canvas);
						pdf.getPage(1).then(function(page) {
							var viewport = page.getViewport({scale: ${scale}});
							var context = canvas.getContext('2d');
							canvas.height = viewport.height;
							canvas.width = viewport.width;
							var renderContext = {
								canvasContext: context,
								viewport: viewport
							};
							var renderTask = page.render(renderContext);
							renderTask.promise.then(function () {
								console.log('Page rendered');
							});
						});
					}			
				})()
			</script>
		</body>
		</html>`;
  }

