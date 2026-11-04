# Clerus

*The other half of TW5.*

To the uninitiated, [TiddlyWiki](https://github.com/TiddlyWiki/TiddlyWiki5) usually looks like a personal notebook, extensible through plugins for greater convenience. Architecturally, however, this is an absurdly superficial reduction: beneath the note editor lies, at the very least, a fully fledged framework for single-page applications. A persistent key-value store whose changes are immediately reflected in the user interface through a reactive dependency graph, using a powerful query/filter language to populate highly expressive template structures with aggregated data—an instrument whose potential, in the opinion of literally every more reflective user, remains utterly unexplored by its established uses. What is particularly interesting is that, over the years, its paradoxical status of *universally acknowledged underappreciation* has not faded in the slightest: TW5 continues to tower inexorably above every attempt to find an application worthy of its conceptual depth.

Clerus was created to finally pull this sword from the stone—I have the audacity to claim an organic *continuation* of TiddlyWiki’s vision in a direction that unlocks its true potential. At present, TW5’s expressive power and architectural grace serve a reactive approach to “capturing, organizing and sharing complex information”: an active operator works with passive tiddlers, and additional code is written essentially only to make those tiddlers look better, easier to edit, or easier to find. Forgive me, colleagues, but we live in the age of agents—the ecological niche of purely reactive tools increasingly resembles a mass grave. Fortunately, TiddlyWiki outgrew it long ago and is receiving its well-deserved promotion to the league of proactive systems for working with complex information.

## Store Authority

At the most basic level, the architecture of Clerus should be understood through its two primary premises:

> At any given moment, all authoritative information about the system’s state is stored exclusively in tiddlers.

> Administrative information is not materialized in tiddlers unless explicitly necessary.

The central architectural principle is that derived information belongs to a perspective, not to the object from which it is derived. Tiddlers contain only non-derivable knowledge, while keeping authority current, determining organizational relationships, managing subscriptions, computing liveness, and other administrative processes take place ephemerally within runtime closures. Information necessary to resume accepted obligations after an unexpected shutdown is considered authoritative.

## Custody and Platforms

Clerus’s proactivity entails a deliberate departure from the principle that “every change to tiddlers records, directly or indirectly, some operator action,” extending it with “or a state transition of an active system element.” The emergence of several independent event sources competing for access to data creates a need for an unambiguous conflict-resolution mechanism. This is provided by the basic principle of “one reads and writes, everyone else only reads,” applied at the granularity of individual tiddlers. The right to overwrite each tiddler is determined by the authoritative `clerus-custody` field, which designates its *responsible custodian* (also called its *home platform*):

- `user`, or an absent field—the user, operating through conventional reactive widgets;
- `browser`—the browser-side Clerus runtime;
- `node`—the Clerus runtime on Node.js.

Lack of custody universally prohibits a platform’s runtime from overwriting tiddlers under another custodian, but holding custody does not grant blanket permission for every action affecting the tiddlers in its care. Every individual operation on a tiddler, whether reading or writing and regardless of its custody, must be substantively justified by the authority of its initiator. For now, we consider only configurations with a single browser tab synchronizing in the standard way with one Node.js process: two autonomous runtimes sharing a store of authoritative state, but without special cross-platform communication protocols.

## Projects and Tasks

From this point onward, the central metaphor is *virtual office administration*. Treating vanilla TW5 as a catalogued archive of arbitrary documents, we supplement it with a universal model of organizational structure that uses this archive for its administrative needs, under the user’s direction. The main interface between the human and the wiki office consists of **projects**: a special type of JSON tiddler that specifies, in detail, an arbitrary ongoing activity managed by the Clerus runtime.

In Clerus, projects encapsulate purposeful activity organized through *structural decomposition*. A tree of subtasks is serialized into the tiddler body in the most obvious way: each node is a record of the form `{ "task": any, "parts": { ... } }`, where the `task` field contains the *configuration* of a particular task in a format understood by its executor, and the nested `parts` record consists of named subtrees of the same form. A task’s unique identifier within a project is its *role*: the sequence of names leading from the root to the addressed subtree.

Projects can operate either in the user’s custody or assigned to one of the platforms. A typical lifecycle pattern is for the operator to create the project root in the conventional reactive interface, then transfer it to the runtime of the appropriate platform, where the subtask tree grows under Clerus’s management. When circumstances arise that the automation did not anticipate, or a phase requiring human attention is reached, control of the project can be returned to the user for manual repair or dissolution.

## Positions and Executors

Task *executors* are extension modules of the special type `module-type: clerus-executor`, whose behavior is determined by interpreting the `task` fields of the projects to which they are assigned. This behavior is expressed exclusively through strictly synchronous functions that react to events dispatched to their area of responsibility. Executors have no stored state of their own, so their workspaces are encapsulated in separate administrative entities called *positions*. At any given moment, no more than one position can be assigned to a task in a project; there is no corresponding restriction in the other direction—a position can participate in several projects, performing multiple roles in each.

Each position is serialized in its own JSON tiddler within the system title namespace, under one of three prefixes:

- `$:/clerus/jobs/` for persistent positions, whose state is synchronized between platforms and resumed after a restart;
- `$:/temp/clerus/jobs/browser/` for ephemeral positions local to the browser;
- `$:/temp/clerus/jobs/node/` for ephemeral positions local to Node.js.

Position titles are globally unique and are never reused.

A persistent position’s responsible custodian can be either `browser` or `node`, whereas ephemeral positions are always assigned to the platform on which their tiddler is visible. An executor is assigned to a position once, when it is created, and remains unchanged until the position is abolished; its identity is stored in the authoritative `clerus-executor` field. The tiddler body—the `text` field—is a record containing the serialized *operational register* of the position (see below). The executor of a persistent position can operate in both the browser and Node.js simultaneously, by defining two separate behavior functions, but only on the home platform can it perform actions that change the position’s register or responsible custodian.

## Documents and Registers

The administrative atoms of Clerus are documents: official records, each attesting to a particular fact significant to the system or the user, and accompanying changes to that fact. A document’s authoritative representation is its JSON serialization, stored in operational and/or transactional registers. In the `browser` and `node` runtimes, each document type is represented by its own *instrumental form*: a JS object that mechanizes the dynamics of the circumstances it records. Modules declaring instrumental forms must define:

- the class of documents covered by the instrumental form;
- the interface provided to the executor for working with those documents;
- document-circulation rules: whether duplication is permitted, restrictions on transmission in the transactional registers of official messages of particular kinds or to particular recipients, the consequences of destruction, and so on;
- the dispatching of events related to the documented circumstances.

Documents are stored and transferred in *registers*: unordered collections serialized as JSON records, whose keys are assigned and interpreted arbitrarily by executors. Each position contains one *operational* register, and each official message carries one *transactional* register. Executor code never has direct access to documents. Instead, it acts through *event contexts*, whose purpose is to extract the required document by key and wrap it in an instance of the appropriate instrumental form. Event contexts give the executor access only to the position’s own registers: one operational register, one incoming transactional register if the event is official, and the transactional registers of outgoing official messages scheduled during that same reaction.

## Administrative Sovereignty

The contents of the operational register fully determine a position’s administrative standing: its responsibilities, the range of authority available for carrying them out, and its participation in the system’s information flow. Message transactional registers are the only means of transferring official documents between positions. No legal executor action can directly modify documents in another position’s operational or transactional registers. However, the behavior of the instrumental forms of its own documents may depend on the contents of other positions’ registers and on other circumstances—for example, the assignment-validity mechanism described below.

The runtime does not conduct office administration on behalf of executors: every act of retaining, transferring, transforming, or destroying a document requires an explicit instrumental operation. Documents are destroyed automatically only together with their enclosing register when a position is lawfully abolished. The recipient of an official message must explicitly dispose of every incoming document; any unhandled contents prevent the reaction from completing successfully. Scheduling an outgoing message that violates the rules likewise invalidates the reaction.

## Standard Instrumental Forms

- *Position charter* (`{ "form": "charter", "book": ?any, "status": any }`). A document mandatory in every operational register but prohibited in transactional registers, created and destroyed together with the position. An establishment mandate (see below) becomes a charter when the executor of a position not yet created accepts it from the transactional register of the founding order. The `book` field is carried over from the mandate used and contains arbitrary JSON defining immutable standing instructions in an executor-specific format. In the `status` field, the executor projects its *working status*: publicly relevant information about the position’s state. Orders addressed to the position are dispatched through its charter.
- *Working memos* (`{ "form": "memo", "data": any }`). The simplest documents, storing information of no official significance at the executors’ discretion. They are created through a special charter method, freely duplicated, and transmitted in any message without restriction. They dispatch no events. They are destroyed silently and without side effects.
- *Ordinary tiddler titles* (strings without special prefixes). The position receives notifications when these tiddlers are created, modified, or deleted, and can read them. Titles can be copied and transmitted in transactional registers, but cannot be created from arbitrary strings: new instances can be returned only by methods of objects already available in the context. They are destroyed silently and without side effects.
- *Titles of other positions* (strings identified by their prefixes). The position receives notifications of changes to the working status of positions known to it, and can inspect that status. Knowing a position’s title allows official orders to be sent to it. These titles can be freely copied, like ordinary tiddler titles, but their transmission in transactional registers is restricted by the rules of subordination (see below). A new position title can be created only through a special charter method. This does not create the position itself, which also requires an establishment mandate. Destroying titles can cause the positions they reference to be removed from project roles, or even abolished altogether.
- *Position establishment mandates* (`{ "form": "contract", "temp": ?boolean, "executor": string, "book": ?any }`). These documents cannot be copied, but can be transmitted in official messages. An order carrying exactly one such mandate in its transactional register may be addressed to the title of a position not yet established. It is dispatched to the executor specified in the mandate, whose acceptance of it creates the tiddler with a new operational register containing a new charter. The optional `temp` field can constrain the choice between persistence and ephemerality for the position being created.
- *Project role assignments* (`{ "form": "mission", "project": string, "role": string[], ... }`). The holder of a *valid* assignment can read the task corresponding to its role and is notified when that task changes or is deleted. In addition, the position can send official reports up the project tree and receive them from below. On the project’s home platform, the position can create, read, modify, and delete the immediate subtasks of its task. The position can create a new assignment to an immediate subtask, simultaneously removing any position previously assigned to that role. Assignments cannot be copied, but a position can transfer them in transactional registers, again subject to the rules of subordination. Destroying an assignment is equivalent to withdrawing from the task and deactivates all assignments below it in the project tree. The mechanism for determining assignment validity is described separately below.

A document’s serialization cannot be `null`, a number, `true`/`false`, or an array.

## Assignments and Organization

Trees of valid assignments to project tasks are guaranteed to satisfy the following structural invariants:

1. For each role in each project, no more than one assignment can be valid at any given moment.
2. Only a root assignment can be valid without a valid assignment to its parent role.
3. Each position’s operational register contains the titles of all other positions holding valid assignments to immediate subtasks of its valid assignments.
4. The relation of *subordination*, defined by a superior holding a subordinate’s title in its register, forms an acyclic directed graph.
5. A persistent position cannot be subordinate to an ephemeral one.

Thus, the tree of valid assignments in any project always remains connected, even when ephemeral subtrees unexpectedly dematerialize, and extends along the edges of the overall subordination graph.

Because every project participant must be able not only to assign other positions to its subtasks but also to remove them forcibly, the mere presence of an assignment in an operational register is insufficient to establish an executor’s authority. The validity of an assignment as a document is determined not only by its own contents, but also by an unbroken chain of records confirming its authority in the assignments of higher-level tasks, all the way to the project root. For this purpose, `mission` documents have three additional fields:

- `link`—a generation identity tag that distinguishes assignments issued at different times for the same project role;
- `issued`—a local issuance counter that prevents tags from being reused in subordinate assignments;
- `children`—the authoritative selection of immediate child assignments, mapping subtask names to their valid generation tags.

The instrumental form authorizes a position’s participation in a project only if its assignment is reachable from the valid root assignment through a chain of valid tags, with the rules of subordination observed at every step. Deletion is the only permitted operation on an assignment that has lost validity. Root assignments are considered the user’s responsibility, and their validity is determined by the most “recent” tag, provided it is unique. The model does not protect against obsolete root assignments being reactivated when the valid one is deleted.

## Messages and Causal Waves

Official messages may travel through the system only along the edges of the subordination graph, whose topology divides the movement of information into two opposite directions of bounded extent. Transferring a transactional register *downward*, from a superior to a subordinate, is called an *order*: such messages are anonymous and addressed to the recipient through its title. Transferring a transactional register *upward*, from a subordinate to a superior, is called a *report*: such messages are addressed to the recipient through a valid task assignment and signed with the corresponding project role.

To preserve the acyclicity of the subordination graph, position titles must not be transmitted in orders addressed either to the position identified by the transmitted title or to any of its transitive subordinates. Titles of persistent positions must not be transmitted in orders addressed to ephemeral positions. A valid assignment may be transmitted in an order only if its parent assignment remains in the sender’s operational register. A valid assignment may be returned to a superior only through that assignment itself, as a final report.

An official message is a consequence of the event in whose reaction it was sent. Each initial event therefore gives rise to a tree of related official messages, hereafter called a *causal wave*. The dispatcher processes a causal wave in a single synchronous pass, successively invoking executor reactions to messages taken from the queue, materializing their effects, and adding the messages scheduled during those reactions to the same queue, until it is completely drained. Reports in reactions to orders are forbidden to prevent causal cycles.

## Reliability and Obligations

Contexts isolate executors from the internal structure of registers, offering instances of the instrumental forms of the documents they contain instead. Every public instrumental call is atomic at the level of preparation and acceptance: a rejected call leaves no partial proposal behind. Different subsequent guarantees apply to reactions of ephemeral and persistent positions.

When an ephemeral position handles an event, all side effects of instrumental calls are materialized immediately. An unexpected system shutdown or an uncaught exception can therefore interrupt the process at any point, with no possibility of recovery. For persistent reactions, by contrast, the system attempts to preserve transactional integrity: the materialization of side effects is deferred until the reaction function completes successfully. This allows the latest actions of a failing executor to be rolled back in their entirety, and interrupted materializations to be resumed and completed.

A persistent position’s reaction to an event can thus be viewed as a two-phase process. First, the runtime constructs a *work plan*, transparently to the executor. After the reaction function completes successfully, it materializes the requested effects in a batch, eliminating executor failure as a factor. To make this procedure not only abortable on error but also resumable after unexpected shutdowns, work-plan materialization guarantees at-least-once delivery, stable identity, and deduplication for official effects.

When reacting to events on a platform other than the one designated by the position’s `clerus-custody`, the executor is subject to only one additional restriction: it cannot write to its own operational register. If the cumulative effect of the plan does not affect local documents, its materialization does not depend on the responsible custodian. For example, even outside its home platform, an executor is allowed to receive a document in an official report, schedule an operation that changes it, and send the result in an order to another subordinate. The document’s transit through the operational register is ephemeral and does not violate the rules.

## Transactional Flows

Clerus guarantees that the movement and transformation of registers through successive activations of persistent positions, linked by chains of causally related official messages, resume from the interrupted operation after unexpected shutdowns, without information loss. This is achieved by maintaining a write-ahead log for each such *transactional flow*, serialized in a separate system JSON tiddler assigned to the platform dispatching the messages.

Each log begins when the executor of a persistent position successfully completes handling an event that is not already part of a registered transactional flow, producing a nonempty work plan. This may be an external event without a transactional register or a report from an ephemeral subordinate. The runtime saves the work plan in a new tiddler, then materializes its requested side effects. Once this process is complete, it replaces the executed plan in the log with a list of the official messages it sends to other persistent positions. In the system dispatch queue, these messages are marked as belonging to the transactional flow initiated in this way.

When the event dispatcher takes an official message registered in a transactional flow from its queue for execution, the work plan produced by handling it replaces the processed message in the existing log rather than creating a new one. This continues until the flow’s final message is processed without registering any new messages; the now-empty log is automatically deleted. When the system starts after an unexpected shutdown, all messages remaining in the logs are placed back into the dispatch queue. If a work plan already accepted for materialization is found among them, it is restarted from the beginning.

There is no one-to-one correspondence between causal waves and transactional flows. A causal wave that begins and ends in ephemeral positions without visiting persistent ones creates no transactional flows. Each report sent by an ephemeral subordinate to a persistent superior during a single causal wave begins a separate transactional flow. A transactional flow interrupted by an error does not end with the causal wave that originated it, and can later be resumed from the surviving log.

It is important to bear in mind that the measures ensuring transactional integrity for official register operations are fairly heavyweight, so persistent positions should not be used to service high-frequency processes. Ephemeral subordinates should be used to offload this work, as their “transparent” operational context is better suited to it.

## Errors and User Control

Instrumental-form methods may throw exceptions if a call is illegal for the position’s executor or impossible for other reasons. The position is considered responsible for handling them correctly. The runtime responds differently to uncaught exceptions depending on the type of position and the circumstances of the failure.

An error in the executor of an ephemeral position terminates its authority entirely. Its tiddler is transferred to the user’s custody (`clerus-custody: user`) for dissection, and a special dismissal event is dispatched to the position itself. In this state, the position can still react to events, but cannot write to its own tiddler. It should use this ability to wind down its relationships with other positions; further errors are not recorded. The assignments of an ephemeral position are considered invalid after its dismissal.

When a persistent position fails on its home platform, the difference from the procedure above resembles the distinction between dismissal and temporary suspension. Transfer of the tiddler to the user’s custody happens in the same way, but participation in projects is preserved. A suspended position should use its limited right to react to events to *hibernate* the subtasks it has entrusted to other positions. If its state can be repaired through conventional reactive tiddler editing, the user can authorize the resumption of its authority by returning `clerus-custody` to its home platform, where it will be notified through a special event.

For errors in persistent positions, the system also attempts to preserve the transactional context: the circumstances of the problem are serialized into the WAL tiddler instead of the work plan. Processing of the transaction’s other branches continues as usual, but when the process is complete, a log containing recorded errors is not deleted. Instead, it too is handed over to the user for dissection. A materialization failure is not treated as an executor failure: the accepted obligation is preserved and blocks new work on top of the unfinished state.

Since the executor of a persistent position on a platform other than its home platform already lacks permission to overwrite its own tiddler, its errors there are considered nondestructive to its own state. The position is not penalized even with temporary suspension, and the circumstances of the problem are saved only in the transaction log.

The user can not only repair WALs but also create them using ordinary TW5 tools: the runtime does not track the continuity of repaired transaction logs. Manually composing a work plan and handing it to the appropriate platform for execution is a legitimate means of controlling the system, without having to take custody of positions already in operation.

## Liveness and Collection

All positions, including persistent ones, are administrative entities: preserving their state does not imply that their existence must be preserved indefinitely. The runtime can automatically abolish positions that are no longer needed, but lack of need does not, by itself, authorize destruction. A position’s liveness belongs to the runtime’s current perspective: it is derived from authoritative documents and outstanding system obligations. Liveness analysis does not modify registers, materialize a history of observations, or delete anything by itself.

A position is retained by:

- a valid assignment, or another document in a state that prohibits destruction;
- a title document in another position’s operational register;
- an unfinished accepted obligation.

Retention is not caused by:

- invalidated assignments;
- mentions of the title in working memos;
- diagnostic copies of messages or other administrative traces.

Suspending a persistent position’s authority does not cancel the grounds for retention it creates. Violated invariants that prevent the presence of retention grounds from being reliably established are interpreted in favor of preservation. A position can be abolished only on its home platform. Collection takes place at the boundary of the outer dispatch pass, accounts for local ephemeral work, and rechecks the conditions before each deletion. Positions released by deletions in the current pass are considered in subsequent passes.
