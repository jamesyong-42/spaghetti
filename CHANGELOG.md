# Changelog

## [0.5.0](https://github.com/jamesyong-42/spaghetti/compare/spaghetti-v0.4.0...spaghetti-v0.5.0) (2026-04-13)


### ⚠ BREAKING CHANGES

* @vibecook/spaghetti-core and @vibecook/spaghetti-ui are replaced by a single package @vibecook/spaghetti-sdk with subpath exports:

### Features

* **apps:** add electron playground using @vibecook/spaghetti-sdk ([5dcfe26](https://github.com/jamesyong-42/spaghetti/commit/5dcfe26e1cd5adcdf99e902d6516d55a7baa1e33))
* **cli:** redesign message blocks in TUI messages view ([2e65c6e](https://github.com/jamesyong-42/spaghetti/commit/2e65c6e7a7a6aa7bced893c5abb62944cb6d73aa))
* **cli:** render assistant markdown in TUI detail view ([c7eaa49](https://github.com/jamesyong-42/spaghetti/commit/c7eaa4969be5c81face4ae060c3baa5db49f2b4a))
* merge spaghetti-core and spaghetti-ui into @vibecook/spaghetti-sdk ([fabf345](https://github.com/jamesyong-42/spaghetti/commit/fabf345acc7cd7d138aa1256092147fd1f50dad3))


### Bug Fixes

* **cli:** use cross-env for FORCE_COLOR=1 in tests ([17a1682](https://github.com/jamesyong-42/spaghetti/commit/17a16823b1dfe12869b6157a9f96de98a9e63383))


### Performance Improvements

* **cli:** switch TUI messages view to line-based scrolling ([be04066](https://github.com/jamesyong-42/spaghetti/commit/be04066ac15c669193ed4b57882c70afedb16c92))

## [0.4.0](https://github.com/jamesyong-42/spaghetti/compare/spaghetti-v0.3.3...spaghetti-v0.4.0) (2026-04-10)


### Features

* add channel plugin for interactive chat with Claude Code sessions ([0e9f877](https://github.com/jamesyong-42/spaghetti/commit/0e9f877))
* **cli:** add doctor command and TUI health-check view ([e1717c0](https://github.com/jamesyong-42/spaghetti/commit/e1717c0))
* **cli:** install and manage both hooks and channel plugins ([f07b386](https://github.com/jamesyong-42/spaghetti/commit/f07b386))


### Bug Fixes

* **channel:** address audit findings - race conditions and reliability ([3d87b64](https://github.com/jamesyong-42/spaghetti/commit/3d87b64))

## [0.3.3](https://github.com/jamesyong-42/spaghetti/compare/spaghetti-v0.3.2...spaghetti-v0.3.3) (2026-04-10)


### Bug Fixes

* **ci:** bump release workflow to Node 24 for npm OIDC auth ([263215d](https://github.com/jamesyong-42/spaghetti/commit/263215d589d47dbda5b92696c035cf3ad35673c6))

## [0.3.2](https://github.com/jamesyong-42/spaghetti/compare/spaghetti-v0.3.1...spaghetti-v0.3.2) (2026-04-10)


### Bug Fixes

* **ci:** remove broken npm self-upgrade step from release workflow ([0da596f](https://github.com/jamesyong-42/spaghetti/commit/0da596f91108df55717db686205d8a5b79b13aef))

## [0.3.1](https://github.com/jamesyong-42/spaghetti/compare/spaghetti-v0.3.0...spaghetti-v0.3.1) (2026-04-10)


### Features

* add @spaghetti/cli with 10 commands and full test suite ([20e8884](https://github.com/jamesyong-42/spaghetti/commit/20e8884fcddd0284b9bb5e511145e2090c26ce50))
* add CI/CD, auto-update, install script, and npm publishing ([7474740](https://github.com/jamesyong-42/spaghetti/commit/74747401bb8488cd4f1f2b0785190f7cd39c4cc4))
* add hooks inspector plugin and CLI hooks monitor ([fee32b5](https://github.com/jamesyong-42/spaghetti/commit/fee32b55a32cdb43732c4e719feaf63863d47832))
* add integration tests, benchmarks, validation suite, and UI fixes ([ee5a52e](https://github.com/jamesyong-42/spaghetti/commit/ee5a52eab177da2915e9c5131658019590619027))
* adopt truffle's CI/CD pattern — separate workflows ([5971cfd](https://github.com/jamesyong-42/spaghetti/commit/5971cfd81b115cb1d242c6ca03d237f501c8d0ff))
* **ci:** replace Changesets with Release-Please for automated releases ([d3ae982](https://github.com/jamesyong-42/spaghetti/commit/d3ae982e42abf42f6a3daadb72e7be426d3171ce))
* **cli:** add generic interactive list with viewport scrolling ([da87cb8](https://github.com/jamesyong-42/spaghetti/commit/da87cb8599f2e475cd43f260f29bca120a582a2b))
* **cli:** add hierarchical browser with 4-level navigation ([f35b41a](https://github.com/jamesyong-42/spaghetti/commit/f35b41a167fc02c3471c32afd676559276483abf))
* **cli:** add scrollbar track to messages view ([6ec6eb3](https://github.com/jamesyong-42/spaghetti/commit/6ec6eb36c0fd83b64a2c187ab883d266a92e5b67))
* **cli:** add session/message/detail semantic colors to theme ([4eb851d](https://github.com/jamesyong-42/spaghetti/commit/4eb851d8074ea136c571b93acb303967851f25aa))
* **cli:** add thin TUI layer with keypress parsing and screen control ([9332dc5](https://github.com/jamesyong-42/spaghetti/commit/9332dc50a011dee192b0e4d2feaceca3bdbf1561))
* **cli:** extract thinking blocks as distinct display items ([90a5bae](https://github.com/jamesyong-42/spaghetti/commit/90a5baef25c05b5cf6796616e177bf1126ef1f8b))
* **cli:** merge task-notification messages into Agent tool-call items ([6656641](https://github.com/jamesyong-42/spaghetti/commit/66566411733aeb7e2a3b322da6ceb201ca981c38))
* **cli:** merge tool_use + tool_result pairs, add tool-specific rendering ([600d5e3](https://github.com/jamesyong-42/spaghetti/commit/600d5e37cbb06150cc729d3e14616ce9beff66b7))
* **cli:** pill-style tab badges with breadcrumb integration ([18c0fe7](https://github.com/jamesyong-42/spaghetti/commit/18c0fe7cd780a88cb5d64e1056ebf4311df836c6))
* **cli:** replace slash commands with menu home, tabs, and search bar ([8e4987c](https://github.com/jamesyong-42/spaghetti/commit/8e4987cd3f889cf33c9d4e48f89373e093e020df))
* **cli:** reverse message order — latest messages at the top ([c42123a](https://github.com/jamesyong-42/spaghetti/commit/c42123ab09370aa7c711510b02deea4aff7e3304))
* **cli:** show 3 body lines for user messages, 2 for claude ([172cdeb](https://github.com/jamesyong-42/spaghetti/commit/172cdebc47a392bcb4a9d11e8c7268df9f2c4f56))
* **cli:** show all message types + interactive filter toggles ([cfcf10c](https://github.com/jamesyong-42/spaghetti/commit/cfcf10c609e6bc660e365f55278c715fa3e103d5))
* **cli:** show truncated session ID right-aligned on session cards ([10e28a7](https://github.com/jamesyong-42/spaghetti/commit/10e28a7c4c8344e9c0b744da27e23323f1398ecf))
* **cli:** TUI redesign — Ink view stack with slash commands ([3c58556](https://github.com/jamesyong-42/spaghetti/commit/3c585569742ee9d1a7a4544826d90a1c19948ceb))
* **cli:** wire interactive browser into spag p with TTY detection ([edc1c4e](https://github.com/jamesyong-42/spaghetti/commit/edc1c4e94b69b3a66b3f74f64ea8f52032dc8951))
* close all CI/CD gaps — lint, format, cross-platform, cleanup ([b96a886](https://github.com/jamesyong-42/spaghetti/commit/b96a886b6b83c246e5e4dad48f1b625099c76c52))
* complete @spaghetti/core with Architecture C cache redesign ([330a6ea](https://github.com/jamesyong-42/spaghetti/commit/330a6ea01ea8a820f83bcc1a349b40c8902ed574))
* publish to npm under [@vibecook](https://github.com/vibecook) scope ([eebb059](https://github.com/jamesyong-42/spaghetti/commit/eebb059d054f5bce2774d4724026d6d627484ad2))
* recover 40,308 messages from legacy databases ([cd9f351](https://github.com/jamesyong-42/spaghetti/commit/cd9f351a293cc554512de42cf832ad19a156f3a7))
* switch to changesets + OIDC trusted publishing (no NPM_TOKEN needed) ([b9fa9dd](https://github.com/jamesyong-42/spaghetti/commit/b9fa9dd98b368b5689be5b3cfefa2942d38a139f))
* truffle-style update system with spaghetti update command ([8a016bf](https://github.com/jamesyong-42/spaghetti/commit/8a016bf921269d12963890d1c092985aa98c6e45))


### Bug Fixes

* add pnpm version to all action-setup steps ([686c9d8](https://github.com/jamesyong-42/spaghetti/commit/686c9d8fef95f87cd4756533fcf14597de73d482))
* add Windows cross-platform compatibility ([3fe9e23](https://github.com/jamesyong-42/spaghetti/commit/3fe9e23671c34845ee8a6ffb01f8b1c9cad80311))
* address 3 CLI UX issues found by QA ([ae12632](https://github.com/jamesyong-42/spaghetti/commit/ae1263205ffe3e62e9b5eb2b04a6616e9ae18de5))
* CI failures — build before typecheck, fix implicit any types ([723cb34](https://github.com/jamesyong-42/spaghetti/commit/723cb344509999bedc0691a396fbe5ed2bf674f3))
* **ci:** use OIDC trusted publishing instead of NPM_TOKEN ([17313f0](https://github.com/jamesyong-42/spaghetti/commit/17313f05ff5f18e489b4f8820c9de3bea57877d4))
* **cli:** add signal handlers, empty states, and scroll indicator format ([b07f28c](https://github.com/jamesyong-42/spaghetti/commit/b07f28ca06685a854cc7ee3c9c3f9009d0e9e35b))
* **cli:** bg color covers full line, user timestamp right-aligned ([75b1675](https://github.com/jamesyong-42/spaghetti/commit/75b16755e813ba01e98b56c80bed785a653507bc))
* **cli:** collapse newlines in project card prompt text ([d56344e](https://github.com/jamesyong-42/spaghetti/commit/d56344e523f1fc66e7bbf4a0f246ab5ec9bc48b2))
* **cli:** collapse newlines in session card prompt text ([ae5f4e0](https://github.com/jamesyong-42/spaghetti/commit/ae5f4e0e77920303849d8f7d23bcb8b7242fa1b4))
* **cli:** consume all tool-result user messages, not just i+1 ([d7c3afc](https://github.com/jamesyong-42/spaghetti/commit/d7c3afcebf5f5e0a97b55cb9f5e7836a17ae98d9))
* **cli:** enable all message filters by default ([c8ee78a](https://github.com/jamesyong-42/spaghetti/commit/c8ee78acbd38de93af740fe0121cf4aa680574f0))
* **cli:** escape from empty states, remove setEncoding, simplify entry ([55a55c5](https://github.com/jamesyong-42/spaghetti/commit/55a55c5a8db72ca23ff2c6e6bbc2b31e62f78f33))
* **cli:** hide progress and internal messages by default ([a5cdacc](https://github.com/jamesyong-42/spaghetti/commit/a5cdacc5ec86dda9fbe92262018fe4c6bc398a0d))
* **cli:** load latest messages first, paginate backward for older ([44ab271](https://github.com/jamesyong-42/spaghetti/commit/44ab2719425b964c97278a3a6e3edf0d39f46697))
* **cli:** move message filter chips above the header rule ([74c9f8a](https://github.com/jamesyong-42/spaghetti/commit/74c9f8af17a0bc92ce27407e732eced7c1ae41f7))
* **cli:** project card text truncation and scroll viewport ([cf62708](https://github.com/jamesyong-42/spaghetti/commit/cf627087ad43de9ecbf0e511e5e35fd9f23783c4))
* **cli:** remove unused getDefaultHookEventsPath import ([4ab9143](https://github.com/jamesyong-42/spaghetti/commit/4ab914387745989e1c48e23241a9e089d4f3a8a5))
* **cli:** resolve lint errors — unused var, control regex, dead code ([95cd8c5](https://github.com/jamesyong-42/spaghetti/commit/95cd8c548513f92670792bb05e2a61e17deaf0fa))
* **cli:** restore HRule and fix ←→ tab switching in messages view ([5663d0d](https://github.com/jamesyong-42/spaghetti/commit/5663d0d2ba79dede6a8283167ff66cc50419e293))
* **cli:** stabilize messages view height to prevent footer jumping ([c4b5071](https://github.com/jamesyong-42/spaghetti/commit/c4b50713c22e454cf580d73c664621efc114c465))
* **cli:** stable scrollbar thumb size based on total message count ([f757cef](https://github.com/jamesyong-42/spaghetti/commit/f757cef76c05f09dbdba764e4c1603224edf6d49))
* **cli:** stop breadcrumb duplication from useEffect re-render loop ([f5a3edb](https://github.com/jamesyong-42/spaghetti/commit/f5a3edbae0fc916a3e8f451af9c0a4e9941d1a3f))
* **cli:** top-right corner gap in welcome panel and boot screen borders ([2213e8e](https://github.com/jamesyong-42/spaghetti/commit/2213e8ee72aa2dc8c6da80185ffad4b00e9bac75))
* **cli:** use official claude plugin CLI for install/uninstall ([3f41a3e](https://github.com/jamesyong-42/spaghetti/commit/3f41a3e3561b762ec2a02e26300253f29b864499))
* improve CLI init progress display and worker fallback ([adad59a](https://github.com/jamesyong-42/spaghetti/commit/adad59a359ed263f64fd39882a7e16dc256175ce))
* mark UI package as private, rename to [@vibecook](https://github.com/vibecook) scope ([3f6fca3](https://github.com/jamesyong-42/spaghetti/commit/3f6fca3b81d1ab90e68ca677c86ff665e1f9d7d0))
* **plugin:** remove explicit hooks reference from manifest ([59e4c27](https://github.com/jamesyong-42/spaghetti/commit/59e4c275a2cf8b87b020d9f2902a35d3fedebdc5))
* **plugin:** remove Stop/SessionStart from additionalContext output ([ceae7a5](https://github.com/jamesyong-42/spaghetti/commit/ceae7a5f3c0a4e42fc0a3cf79981698c9a6b76c7))
* progress display stays on one line, truncate long slug names ([bfc1a99](https://github.com/jamesyong-42/spaghetti/commit/bfc1a99c7eb0c6e0fece935d2ea66e3be16cbd10))
* remove nav from deps since setSubtitle is a stable setState. ([f5a3edb](https://github.com/jamesyong-42/spaghetti/commit/f5a3edbae0fc916a3e8f451af9c0a4e9941d1a3f))
* rename @spaghetti/core to @vibecook/spaghetti-core in UI package ([39b2557](https://github.com/jamesyong-42/spaghetti/commit/39b25575f227d24b94728c43e3767daeb944ec85))
* resolve all lint errors across cli, core, and ui packages ([fab0bc5](https://github.com/jamesyong-42/spaghetti/commit/fab0bc57f7118b21279bc0b1951a1704fd443c7c))
* resolve SQLITE_BUSY, worker deadlock, and error handling bugs ([23598a3](https://github.com/jamesyong-42/spaghetti/commit/23598a3ddbc268e405fd29e7edc8241479396b8c))
* resolve stale sessions-index causing 0 messages for 14 projects ([0ef23c5](https://github.com/jamesyong-42/spaghetti/commit/0ef23c5000b8fdca5496e9152b6cf2850d2edc23))


### Performance Improvements

* **cli:** update header/footer in-place instead of recreating list ([8dd3a4a](https://github.com/jamesyong-42/spaghetti/commit/8dd3a4a2595c805899175f3aed1eff24a4874592))
