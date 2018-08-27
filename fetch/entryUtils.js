define([
	'core/workerUtils',
	'path:./loaderWorker',
], (
	workerUtils,
	pathLoaderWorker
) => {
	/* eslint-env worker */
	'use strict';

	/* jshint worker: true */

	function unescapeHTML(code) {
		// TODO: ideally would not require access to the DOM
		// Thanks, https://stackoverflow.com/a/7394787/1180785
		const o = window.document.createElement('textarea');
		o.innerHTML = code;
		return o.value;
	}

	function parseEntry(entry, index) {
		return {
			id: 'E' + index,
			answerID: entry.answerID,
			userName: entry.userName,
			userID: entry.userID,
			title: unescapeHTML(entry.title),
			codeBlocks: entry.codeBlocks.map(unescapeHTML),
			enabled: entry.enabled,
			pauseOnError: false,
		};
	}

	function stringifyCompileError(e, prefix = '') {
		if(typeof e !== 'object') {
			return prefix + String(e);
		}
		const location = (e.lineNumber || e.line || 'unknown line');
		if(e.message) {
			return prefix + e.message + ' @ ' + location;
		}
		return prefix + e.toString() + ' @ ' + location;
	}

	function stringifyEntryError(e, prefix = 'Threw ') {
		if(typeof e !== 'object') {
			return prefix + String(e);
		}
		if(e.stack) {
			const stack = e.stack;
			const m = stack.match(/:([0-9]+):([0-9]+)?/);
			if(m) {
				return (
					prefix + e.message +
					' (line ' + (m[1] - 1) + ' column ' + (m[2] || 0) + ')'
				);
			} else {
				return prefix + e.stack;
			}
		}
		if(e.message) {
			return prefix + e.message;
		}
		return prefix + e.toString();
	}

	function findCandidates(code, varExpr) {
		if(varExpr.indexOf('*') === -1) {
			return new Set([varExpr]);
		}
		const regex = new RegExp(varExpr.replace(/\*/g, '[a-zA-Z0-9_]*'), 'g');
		const found = new Set();
		for (;;) {
			const p = regex.exec(code);
			if(!p) {
				break;
			}
			found.add(p[0]);
		}
		return found;
	}

	function buildFunctionFinder(code, returning, putPrefix='', searchPrefix='') {
		let parts = '';
		for(let k of Object.keys(returning)) {
			if(!returning.hasOwnProperty(k)) {
				continue;
			}
			parts += JSON.stringify(k) + ':';
			const vars = findCandidates(code, searchPrefix+returning[k]);
			if(vars.size === 1) {
				parts += putPrefix+vars.values().next().value.slice(searchPrefix.length);
			} else if(vars.size > 1) {
				parts += (
					'((() => {' +
						vars.map((v) => 'try {return ' +
						putPrefix+v.slice(searchPrefix.length) + ';} catch(e) {}').join('') +
					'})())'
				);
			} else {
				parts += 'null';
			}
			parts += ',';
		}
		return 'return {' + parts + '};';
	}

	return {
		findCandidates,
		buildFunctionFinder,
		compile: function ({
			initCode = '',
			initParams = {},
			initPre = '',
			initSloppy = false,
		} = {}, otherMethods = {}) {
			const boilerplateBlock = `
				const self = undefined;
				const window = undefined;
				const require = undefined;
				const requireFactory = undefined;
				const define = undefined;
				const addEventListener = undefined;
				const removeEventListener = undefined;
				const postMessage = undefined;
				const Date = undefined;
				const performance = undefined;
				const params = undefined;
			`;

			// Wrap code in function which blocks access to obviously dangerous
			// globals (this wrapping cannot be relied on as there may be other
			// ways to access global scope, but should prevent accidents - other
			// measures must be used to prevent malice)
			const buildSrc = ((`
				self.initFn = function(params) {
					${initSloppy?'':'\'use strict\';'}
					${initPre};
					self.initObj = new (function({
						${Object.keys(initParams).join(',')}
					}) {
						${boilerplateBlock}
			`).replace(/(\r\n\t|\n|\r\t)/gm,'') + initCode + `
					})(params);
				};
			`);

			let compileError = null;
			let fns = {};
			let initObj;

			const begin = performance.now();
			try {
				importScripts(URL.createObjectURL(new Blob(
					[buildSrc],
					{type: 'text/javascript'}
				)));
				self.initFn(initParams);
				initObj = self.initObj;
			} catch (e) {
				if(e.toString().includes('DOM Exception 19')) {
					try {
						/* jshint evil: true */
						eval(buildSrc);
						self.initFn(initParams);
						initObj = self.initObj;
					} catch(e2) {
						compileError = 'initialization: ' + stringifyCompileError(e2);
					}
				} else {
					compileError = 'initialization: ' + stringifyCompileError(e);
				}
			}
			self.initFn = null;

			for (let fnKey of Object.keys(otherMethods)) {
				if (compileError) {
					break;
				}
				let thing = otherMethods[fnKey];
				let fnPre = thing.hasOwnProperty('pre')?thing.pre:'';
				let fnCode = thing.hasOwnProperty('code')?thing.code:'';
				let fnParams = thing.hasOwnProperty('params')?thing.params:[];
				const runSrc = ((`
					self.runFn = function(params, extras) {
						${thing.sloppy?'':'\'use strict\';'}
						console = (extras.consoleTarget ?
						((({
							consoleTarget,
							consoleLimit = 100,
							consoleItemLimit = 1024
						}) => {
							const dolog = (type, values) => {
								consoleTarget.push({
									type,
									value: Array.prototype.map.call(values, (v) => {
										if(v && v.message) {
											return String(v.message);
										}
										try {
											return JSON.stringify(v);
										} catch(e) {
											return String(v);
										}
									}).join(" ").substr(0, consoleItemLimit),
								});
								if(consoleTarget.length > consoleLimit) {
									consoleTarget.shift();
								}
							};
							return {
								clear: () => {consoleTarget.length = 0;},
								info: function() {dolog("info", arguments);},
								log: function() {dolog("log", arguments);},
								warn: function() {dolog("warn", arguments);},
								error: function() {dolog("error", arguments);},
							};
						})(extras)) : undefined);
						${fnPre}
						extras = undefined;
						return (({${fnParams.join(',')}})=>{
							${boilerplateBlock}
						`).replace(/(\r\n\t|\n|\r\t)/gm, '') +
							`${fnCode};
						}).call(params['this']||{}, params);
					};
				`);
				try {
					importScripts(URL.createObjectURL(new Blob(
						[runSrc],
						{type: 'text/javascript'}
					)));
					let runFn = self.runFn;
					fns[fnKey] = (params={}, extras={}) => {
						return runFn.apply({}, [
							Object.assign({}, initObj, params),
							extras,
						]);
					};
				} catch (e) {
					if(e.toString().includes('DOM Exception 19')) {
						try {
							/* jshint evil: true */
							eval(runSrc);
							let runFn = self.runFn;
							fns[fnKey] = (params={}, extras={}) => runFn.apply({}, [
								Object.assign({}, initObj, params),
								extras,
							]);
						} catch(e2) {
							compileError = fnKey + ': ' + stringifyCompileError(e2);
						}
					} else {
						compileError = fnKey + ': ' + stringifyCompileError(e);
					}
				}
				self.runFn = null;
			}

			self.initObj = null;
			const compileTime = performance.now() - begin;

			return {fns, compileError, compileTime};
		},

		stringifyEntryError,

		load: (site, qid, progressCallback) => {
			const loaderWorker = workerUtils.make(pathLoaderWorker);

			return new Promise((resolve, reject) => {
				loaderWorker.addEventListener('message', (event) => {
					const data = event.data;
					if(data.error) {
						loaderWorker.terminate();
						reject(data.error);
						return;
					}
					if(!data.entries) {
						if(progressCallback) {
							progressCallback(data.loaded, data.total);
						}
						return;
					}
					loaderWorker.terminate();
					resolve(data.entries.map(parseEntry));
				});

				loaderWorker.postMessage({site, qid});
			});
		},
	};
});
