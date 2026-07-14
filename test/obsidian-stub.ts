/**
 * A working stand-in for the `obsidian` module, so the UI can actually be tested.
 *
 * The previous version of this file was four lines and exported `apiVersion`. It existed
 * only to stop esbuild choking on the import — which meant the test harness for `.test.ts`
 * files was real but had never been pointed at anything, and every UI behaviour (settings
 * rendering, Pro gating, panel state) was defended by nothing but comments.
 *
 * This implements enough of Obsidian's HTMLElement extensions and Setting/View classes to
 * construct the real components and assert on what they render. It is a stub, not a mock:
 * the code under test is the shipped code, unmodified.
 */

// --- a minimal DOM ----------------------------------------------------------------------

export class FakeEl {
	tag: string;
	children: FakeEl[] = [];
	parent: FakeEl | null = null;
	classes = new Set<string>();
	attrs: Record<string, string> = {};
	cssProps: Record<string, string> = {};
	dataset: Record<string, string> = {};
	textContent = "";
	listeners: Record<string, Array<(event: unknown) => void>> = {};

	constructor(tag = "div") {
		this.tag = tag;
	}

	// --- Obsidian's HTMLElement extensions ---
	createEl(tag: string, options?: { cls?: string; text?: string; href?: string }): FakeEl {
		const child = new FakeEl(tag);
		if (options?.cls) options.cls.split(/\s+/).filter(Boolean).forEach((c) => child.classes.add(c));
		if (options?.text) child.textContent = options.text;
		if (options?.href) child.attrs.href = options.href;
		child.parent = this;
		this.children.push(child);
		return child;
	}

	createDiv(options?: { cls?: string; text?: string }): FakeEl {
		return this.createEl("div", options);
	}

	createSpan(options?: { cls?: string; text?: string }): FakeEl {
		return this.createEl("span", options);
	}

	setText(text: string): void {
		this.textContent = text;
	}

	appendText(text: string): void {
		this.textContent += text;
	}

	addClass(...cls: string[]): void {
		cls.forEach((c) => this.classes.add(c));
	}

	removeClass(...cls: string[]): void {
		cls.forEach((c) => this.classes.delete(c));
	}

	hasClass(cls: string): boolean {
		return this.classes.has(cls);
	}

	setAttr(key: string, value: string): void {
		this.attrs[key] = value;
	}

	removeAttribute(key: string): void {
		delete this.attrs[key];
	}

	setCssProps(props: Record<string, string>): void {
		Object.assign(this.cssProps, props);
	}

	setCssStyles(styles: Record<string, string>): void {
		// Deliberately NOT applied to cssProps. This is the real behaviour that shipped a bug:
		// setCssStyles is Object.assign onto a CSSStyleDeclaration, so a "--custom-prop" key
		// lands as a dead JS expando and sets no CSS variable. A test that asserts on
		// cssProps therefore fails if anyone reaches for setCssStyles again.
		Object.assign(this, { _styles: styles });
	}

	empty(): void {
		this.children = [];
		this.textContent = "";
	}

	addEventListener(type: string, handler: (event: unknown) => void): void {
		(this.listeners[type] ??= []).push(handler);
	}

	/**
	 * Minimal attribute/class selector, enough for the delegation the panel actually uses.
	 * Without this — and without bubbling, below — a delegated listener would never fire, and
	 * a test would silently "pass" on a panel whose rows do nothing when clicked.
	 */
	closest(selector: string): FakeEl | null {
		const attr = /^\[([\w-]+)\]$/.exec(selector);
		const dataKey = attr ? camel(attr[1].replace(/^data-/, "")) : null;
		const cls = selector.startsWith(".") ? selector.slice(1) : null;

		let node: FakeEl | null = this;
		while (node) {
			if (cls && node.classes.has(cls)) return node;
			if (dataKey && node.dataset[dataKey] !== undefined) return node;
			node = node.parent;
		}
		return null;
	}

	// --- test affordances ---
	/** Every element in the subtree, this one included. */
	all(): FakeEl[] {
		return [this, ...this.children.flatMap((child) => child.all())];
	}

	find(predicate: (el: FakeEl) => boolean): FakeEl | undefined {
		return this.all().find(predicate);
	}

	findAll(predicate: (el: FakeEl) => boolean): FakeEl[] {
		return this.all().filter(predicate);
	}

	/** All visible text in the subtree, joined — for asserting on copy. */
	text(): string {
		return this.all()
			.map((el) => el.textContent)
			.filter(Boolean)
			.join(" ");
	}

	/** Dispatch a click that BUBBLES, because delegation is the whole point of the panel's
	 * single listener — a fake DOM without bubbling would test a panel that cannot exist. */
	click(): void {
		const event = { target: this as FakeEl };
		let node: FakeEl | null = this;
		while (node) {
			for (const handler of node.listeners.click ?? []) handler(event);
			node = node.parent;
		}
	}
}

// --- controls ----------------------------------------------------------------------------

export class ToggleComponent {
	value = false;
	disabled = false;
	private handler: ((value: boolean) => unknown) | null = null;
	setValue(value: boolean): this {
		this.value = value;
		return this;
	}
	onChange(handler: (value: boolean) => unknown): this {
		this.handler = handler;
		return this;
	}
	setDisabled(disabled: boolean): this {
		this.disabled = disabled;
		return this;
	}
	/** Drive the control the way a user would. */
	toggle(value: boolean): unknown {
		this.value = value;
		return this.handler?.(value);
	}
}

export class SliderComponent {
	value = 0;
	limits: [number, number, number] = [0, 0, 0];
	private handler: ((value: number) => unknown) | null = null;
	setLimits(min: number, max: number, step: number): this {
		this.limits = [min, max, step];
		return this;
	}
	setValue(value: number): this {
		this.value = value;
		return this;
	}
	setDynamicTooltip(): this {
		return this;
	}
	onChange(handler: (value: number) => unknown): this {
		this.handler = handler;
		return this;
	}
	drag(value: number): unknown {
		this.value = value;
		return this.handler?.(value);
	}
}

export class TextComponent {
	value = "";
	placeholder = "";
	private handler: ((value: string) => unknown) | null = null;
	setPlaceholder(text: string): this {
		this.placeholder = text;
		return this;
	}
	setValue(value: string): this {
		this.value = value;
		return this;
	}
	onChange(handler: (value: string) => unknown): this {
		this.handler = handler;
		return this;
	}
	type(value: string): unknown {
		this.value = value;
		return this.handler?.(value);
	}
}

export class ButtonComponent {
	label = "";
	icon = "";
	tooltip = "";
	disabled = false;
	private handler: (() => unknown) | null = null;
	setButtonText(text: string): this {
		this.label = text;
		return this;
	}
	setIcon(icon: string): this {
		this.icon = icon;
		return this;
	}
	setTooltip(tooltip: string): this {
		this.tooltip = tooltip;
		return this;
	}
	setDisabled(disabled: boolean): this {
		this.disabled = disabled;
		return this;
	}
	onClick(handler: () => unknown): this {
		this.handler = handler;
		return this;
	}
	press(): unknown {
		return this.handler?.();
	}
}

export class Setting {
	/** Every Setting built since the last reset, so a test can drive the real controls. */
	static instances: Setting[] = [];
	static reset(): void {
		Setting.instances = [];
	}

	settingEl: FakeEl;
	nameEl: FakeEl;
	descEl: FakeEl;
	name = "";
	desc = "";
	isHeading = false;
	toggles: ToggleComponent[] = [];
	sliders: SliderComponent[] = [];
	texts: TextComponent[] = [];
	buttons: ButtonComponent[] = [];
	extraButtons: ButtonComponent[] = [];

	constructor(containerEl: FakeEl) {
		Setting.instances.push(this);
		this.settingEl = containerEl.createDiv({ cls: "setting-item" });
		this.nameEl = this.settingEl.createDiv({ cls: "setting-item-name" });
		this.descEl = this.settingEl.createDiv({ cls: "setting-item-description" });
	}

	setName(name: string): this {
		this.name = name;
		this.nameEl.setText(name);
		return this;
	}
	setDesc(desc: string): this {
		this.desc = desc;
		this.descEl.setText(desc);
		return this;
	}
	setHeading(): this {
		this.isHeading = true;
		this.settingEl.addClass("setting-item-heading");
		return this;
	}
	addToggle(cb: (toggle: ToggleComponent) => unknown): this {
		const toggle = new ToggleComponent();
		this.toggles.push(toggle);
		cb(toggle);
		return this;
	}
	addSlider(cb: (slider: SliderComponent) => unknown): this {
		const slider = new SliderComponent();
		this.sliders.push(slider);
		cb(slider);
		return this;
	}
	addText(cb: (text: TextComponent) => unknown): this {
		const text = new TextComponent();
		this.texts.push(text);
		cb(text);
		return this;
	}
	addButton(cb: (button: ButtonComponent) => unknown): this {
		const button = new ButtonComponent();
		this.buttons.push(button);
		cb(button);
		return this;
	}
	addExtraButton(cb: (button: ButtonComponent) => unknown): this {
		const button = new ButtonComponent();
		this.extraButtons.push(button);
		cb(button);
		return this;
	}
	/** Every control on this row — a Pro row for a free user must have none. */
	controls(): Array<ToggleComponent | SliderComponent | TextComponent | ButtonComponent> {
		return [...this.toggles, ...this.sliders, ...this.texts, ...this.buttons];
	}
}

// --- views, plugins, notices --------------------------------------------------------------

export class Component {
	registerDomEvent(el: FakeEl, type: string, handler: (event: unknown) => void): void {
		el.addEventListener(type, handler);
	}
	registerEvent(): void {
		/* no-op */
	}
}

export class PluginSettingTab extends Component {
	containerEl = new FakeEl();
	constructor(
		public app: unknown,
		public plugin: unknown
	) {
		super();
	}
}

export class ItemView extends Component {
	contentEl = new FakeEl();
	constructor(public leaf: unknown) {
		super();
	}
}

export class Modal extends Component {
	contentEl = new FakeEl();
	titleEl = new FakeEl();
	constructor(public app: unknown) {
		super();
	}
	open(): void {
		/* no-op */
	}
	close(): void {
		/* no-op */
	}
}

export class Plugin extends Component {
	/** Stands in for data.json. A test writes it, `loadData()` reads it, exactly like the disk. */
	data: unknown = null;

	constructor(
		public app: unknown,
		public manifest: unknown
	) {
		super();
	}

	async loadData(): Promise<unknown> {
		return this.data;
	}

	async saveData(data: unknown): Promise<void> {
		// Round-trip through JSON, because data.json does: this is what turns a settings object
		// holding a Map or an undefined into whatever actually comes back on the next load.
		this.data = JSON.parse(JSON.stringify(data));
	}

	addStatusBarItem(): FakeEl {
		return new FakeEl();
	}
	addCommand(): void {
		/* no-op */
	}
	addSettingTab(): void {
		/* no-op */
	}
	registerView(): void {
		/* no-op */
	}
	registerInterval(id: number): number {
		return id;
	}
	registerDomEvent(el: FakeEl, type: string, handler: (event: unknown) => void): void {
		el.addEventListener(type, handler);
	}
	register(): void {
		/* no-op */
	}
}

export class MarkdownView extends ItemView {}

export class SuggestModal<T> extends Modal {
	limit = 0;
	emptyStateText = "";
	inputEl = new FakeEl("input");
	setPlaceholder(_text: string): void {
		/* no-op */
	}
	getSuggestions(_query: string): T[] {
		return [];
	}
}

/**
 * The desktop-only vault adapter. EngineHost only ever asks `adapter instanceof
 * FileSystemAdapter`, and for a stub vault the honest answer is "no" — so this is a class that
 * nothing is an instance of, on purpose.
 */
export class FileSystemAdapter {}

export class TFile {
	path = "";
	basename = "";
	extension = "md";
	stat = { mtime: 0, ctime: 0 };
}

/** Obsidian's own: collapse slashes, drop a leading/trailing one. Enough for a vault path. */
export function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
}

/** Notices raised during a test, so a test can assert what the user was told. */
export const notices: string[] = [];

export class Notice {
	constructor(message: string) {
		notices.push(message);
	}
}

export const apiVersion = "1.5.0";
export const Platform = { isMacOS: false, isIosApp: false };

function camel(value: string): string {
	return value.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * The panel narrows its click target with `instanceof HTMLElement` before using it. Node has
 * no DOM, so without this the guard silently rejects every event and the delegated handler
 * never runs — a test would pass against a panel whose rows are dead.
 */
(globalThis as Record<string, unknown>).HTMLElement = FakeEl;
export { FakeEl as HTMLElement };
