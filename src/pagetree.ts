import * as vscode from 'vscode';
import { PDFDocument, PDFPage, rgb } from 'pdf-lib'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as url from 'node:url';

/** Context data for PageItems */
export class PageItemContext {
    constructor(public pdfPage: PDFPage, public pageIndex: number) {}
}

/** A TreeItem with predefined behavior and attached context data */
export class PageItem extends vscode.TreeItem {
    private static ICON = new vscode.ThemeIcon("file-pdf");
    constructor(label: string, description?: string, public data?: PageItemContext) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.description = description;
        this.contextValue = 'pdfPage';
        this.iconPath = PageItem.ICON;
    }
}

/** TreeProvider for PDF pages */
export class PageTreeProvider implements vscode.TreeDataProvider<PageItem>, vscode.TreeDragAndDropController<PageItem> {
    private pdfContainer: PDFDocument | undefined;
    private static MIME_TYPE = 'application/vnd.code.tree.pdf-tools';
    private static PLACEHOLDER_ITEM = new PageItem("<none>");
    dropMimeTypes: readonly string[] = [PageTreeProvider.MIME_TYPE, "text/uri-list" ];
    dragMimeTypes: readonly string[] = [PageTreeProvider.MIME_TYPE];

    private _onDidChangeTreeData: vscode.EventEmitter<PageItem | undefined | null |void> = new vscode.EventEmitter<PageItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<PageItem | undefined | null |void> = this._onDidChangeTreeData.event;
    
    constructor(private data: PageItem[]) {}
    
    /** Asynchronous post-initialization */
    public async initialize() {
        this.pdfContainer = await PDFDocument.create();
    }
    
    /** @see vscode.TreeItem */
    getTreeItem(element: PageItem) : vscode.TreeItem | Thenable<vscode.TreeItem> {
        return element;
    }
    
    /** @see vscode.TreeItem */
    getChildren(element?: PageItem | undefined): vscode.ProviderResult<PageItem[]> {
        return element ? [] : this.data
    }
    
    /** Refreshes the tree UI either for the currently available data or the given */
    public refreshTree(data?: PageItem[]): void {
        if( data ) {
            this.data = data;
        }
        this.data = this.data.filter(x => x !== undefined && x !== PageTreeProvider.PLACEHOLDER_ITEM);
        if( this.data.length === 0) {
            this.data.push(PageTreeProvider.PLACEHOLDER_ITEM);
        }
        this._onDidChangeTreeData.fire(null);
    }

    public getPageItems() {
        return this.data;
    }

    /** Refreshes the model (pdfContainer) */
    public async refreshModel() {
        const newDoc = await PDFDocument.create();
        const pages = await newDoc.copyPages(this.pdfContainer!, this.pdfContainer!.getPageIndices());
        for(const page of pages) {
            newDoc.addPage(page);
        }
        const newData = this.data.map(x => new PageItem(x.label as string, x.description as string, {pdfPage: pages[x.data!.pageIndex], pageIndex: x.data!.pageIndex}));
        this.pdfContainer = newDoc;
        this.refreshTree(newData);
    }

    /** Resets the model to an empty PDFDocument */
    public async clear() {
        this.data = [];
        await this.initialize();
        this.refreshTree();
    }
    
    /** Drag handler */
    handleDrag(source: readonly any[], dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): void | Thenable<void> {
        dataTransfer.set(PageTreeProvider.MIME_TYPE, new vscode.DataTransferItem(source));
    }

    /** Drop handler for PageItems or PDF files */
    async handleDrop(target: any | undefined, sources: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void> {
        if( sources.get(PageTreeProvider.MIME_TYPE) ) {
            this.moveTo(sources.get(PageTreeProvider.MIME_TYPE)!.value, target)
        } else {
            const transferItem = sources.get("text/uri-list");
            if( transferItem ) {
                const fileNames = (await transferItem.asString()) .split("\r\n");
                for(const fileName of fileNames) {
                    const path = url.fileURLToPath(fileName)
                    if( fileName.toLowerCase().endsWith(".pdf") ) {
                        await this.addPdfFile(path, target);
                    } else {
                        const stat = await fs.lstat(path);
                        if(stat && stat.isDirectory() ) {
                            for await (const file of this.walk(path)) {
                                if( file.toLowerCase().endsWith(".pdf")) {
                                    await this.addPdfFile(file, target);            
                                }
                            }
                        }
                    }
                }
            }
        }
        this.refreshTree();
	}

    private async* walk(dir: string): any {
        for await (const d of await fs.opendir(dir)) {
            const entry = path.join(dir, d.name);
            if (d.isDirectory()) yield* await this.walk(entry);
            else if (d.isFile() && d.name.toLowerCase().endsWith(".pdf")) yield entry;
        }
      }

    private async addPdfFile(fileName: string, target: any | undefined) {
        const existingPdfBytes = await fs.readFile(fileName);
        const sourcePdf = await PDFDocument.load(existingPdfBytes);
        const pages = await this.pdfContainer!.copyPages(sourcePdf, sourcePdf.getPageIndices());
        const moveableItems = [];
        for(const [index,page] of pages.entries()) {
            this.pdfContainer!.addPage(page);
            const pageIndex = this.pdfContainer!.getPageCount()-1;
            const item = new PageItem(fileName.substring(fileName.lastIndexOf("/")+1, fileName.length - 4), "#" + (index+1), new PageItemContext(page, pageIndex));
            this.data.push(item);
            if( target ) {
                moveableItems.push(item);
            }
        }
        this.moveTo(moveableItems, target);
    }

    /** Move PageItem(s) to the position of a certain PageItem  */
    private moveTo(items: PageItem[], target: PageItem | null) {
        // TODO: move upwards works fine, downwards should be placed one step ahead...
        const moveToTop = target && this.data.indexOf(target) === 0;
        this.data = this.data.filter(e => !items.includes(e));
        const targetPosition = moveToTop ? 0 : target ? this.data.indexOf(target)+1 : this.data.length-1;
        this.data.splice(targetPosition, 0, ...items);
    }

    /** Modifies the label (and description) of a PageItem  */
    public rename(label: string, items: PageItem[]) {
        let pageCounter = 0;
        items.forEach(item => {
            item.label = label;
            item.description = "#" + (++pageCounter);
        });
        this.refreshTree();
    }

    /** Removes PageItem(s) */
    public remove(items: PageItem[] ) {
        this.refreshTree(this.data.filter(item => !items.includes(item)));
    }

    public crop(items: PageItem[], config: any) {
        for(const item of items) {
            const pageSize = item.data?.pdfPage.getSize();
            
            const x = config.selection.x1 * pageSize!.width/config.pageWidth,
                  y = (config.selection.y1 * pageSize!.height/config.pageHeight);
            const width = (config.selection.x2 * (pageSize!.width/config.pageWidth)) - x,
                  height = ((config.selection.y2 * pageSize!.height/config.pageHeight) - y);
            item.data?.pdfPage.setCropBox(x,pageSize!.height-y,width,height*-1)
        }
    }

    /** Split a single page into two (e.g. A3=>2xA4, A4=2xA5) */
    public async split(direction: "h" | "v", pageItems: PageItem[]): Promise<PageItem[]> {
        const newItems: PageItem[] = [];
        for(let pageItem of pageItems ) {
            try {
                let isHorizontal = direction === 'h';
                const page = pageItem.data!.pdfPage;
                if(page.getRotation().angle / 90 % 2 === 1 ) {
                    isHorizontal = !isHorizontal;
                }
                if( (isHorizontal && page.getHeight() < page.getWidth()) ||
                    (!isHorizontal && page.getWidth() < page.getHeight())) {
                        const insertIndex = this.data.indexOf(pageItem);
                        const [leftPage,rightPage] = (await this.pdfContainer!.copyPages(this.pdfContainer!, [pageItem.data!.pageIndex, pageItem.data!.pageIndex]));
                        const h = isHorizontal ? page.getWidth() / 2 : 0;
                        const v = !isHorizontal ? page.getHeight() / 2: 0;
                        const width = isHorizontal ? page.getWidth() / 2 : page.getWidth();
                        const height = !isHorizontal ? page.getHeight() / 2 : page.getHeight();
                        leftPage.setCropBox(0,0,width,height);
                        leftPage.setMediaBox(0,0,width,height);
                        leftPage.setArtBox(0,0,width,height);
                        leftPage.setBleedBox(0,0,width,height);
                        leftPage.setSize(width, height);
                        this.pdfContainer!.addPage(leftPage);
                        const leftPageIndex = this.pdfContainer!.getPageCount()-1;
                        rightPage.setCropBox(h,v,width,height);
                        rightPage.setMediaBox(h,v,width,height);
                        rightPage.setArtBox(h,v,width,height);
                        rightPage.setBleedBox(h,v,width,height);
                        rightPage.setSize(width,height);
                        this.pdfContainer!.addPage(rightPage);
                        const rightPageIndex = this.pdfContainer!.getPageCount()-1;
                        const leftNode = new PageItem(pageItem.label as string, isHorizontal ? "#A" : "#B", new PageItemContext(leftPage, leftPageIndex)),
                            rightNode = new PageItem(pageItem.label as string, isHorizontal ? "#B": "#A", new PageItemContext(rightPage, rightPageIndex));
                        isHorizontal ? this.data.splice(insertIndex, 1, leftNode, rightNode)
                                          : this.data.splice(insertIndex, 1, rightNode, leftNode);
                        isHorizontal ? newItems.push(leftNode, rightNode) 
                                          : newItems.push(rightNode, leftNode);
                }
            } catch( error ) {
                console.error(error);
            }
        }
        this.refreshTree();
        return newItems;
    }

    /** Combine two pages into one (e.g. 2xA5=>A4, 2xA4=>A3) */
    public async combine(direction: "h" | "v", left: PageItem, right:PageItem): Promise<PageItem> {
        const page = this.pdfContainer!.addPage();

        const [embeddedA, embeddedB] = await this.pdfContainer!.embedPdf(this.pdfContainer!, [left.data!.pageIndex, right.data!.pageIndex])
        if( direction === 'h' ){
            page.setSize(embeddedA.width*2, embeddedA.height)
            page.drawPage(embeddedA, {x: 0, y: 0});
            page.drawPage(embeddedB, { x: embeddedA.width, y: 0});
        } else {
            page.setSize(embeddedA.width, embeddedA.height*2);
            page.drawPage(embeddedB, {x: 0, y: 0});
            page.drawPage(embeddedA, { x: 0, y: embeddedA.height});
        }
        this.pdfContainer!.addPage(page);
        const newItem = new PageItem(left.label as string, left.description + " " + right.description, new PageItemContext(page, this.pdfContainer!.getPageCount()-1));
        this.data.splice(this.data.indexOf(left),0,newItem)
        this.remove([left, right]);
        this.refreshTree();
        return newItem;
    }

    /** Create a PDFDocument from the given PageItems */
    public async pdfFrom(items: PageItem[], reload: boolean = true, showGrid = false): Promise<PDFDocument> {
        const result = await PDFDocument.create();
        result.setAuthor('');
        result.setProducer('')
        result.setCreator('')
        const indices = items.map(item => item.data!.pageIndex);
        if( this.pdfContainer) {
            const pages = await result.copyPages(this.pdfContainer, indices);
            for(const page of pages) {
                result.addPage(page);
                if( showGrid ) {
                    for(let x = 0; x < page.getWidth(); x += 10) {   
                        page.drawLine({
                            start: {x, y: 0},
                            end: {x, y: page.getHeight()},
                            thickness: 1,
                            color: rgb(0.5, 0.5, 0.5),
                            opacity: 0.5
                        });
                    }
                    for( let y = 0; y < page.getHeight(); y += 10) {
                        page.drawLine({
                            start: {x: 0, y},
                            end: {x: page.getWidth(), y},
                            thickness: 1,
                            color: rgb(0.5, 0.5, 0.5),
                            opacity: 0.5
                        });
                    }
                }
            }
        }
        if( reload ){
            await this.refreshModel();
        }
        return result;
    }

    public async sort(ascending: boolean) {
        this.data.sort((a,b) => a.label === b.label ? 0 : (a.label || "") < (b.label || "") ? (ascending ? 1 : -1) : (ascending ? -1 : 1));
        this.refreshTree();
    } 
}