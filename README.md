# Clerus

*The other half of TW5.*

To the uninitiated, TiddlyWiki usually looks like a personal notebook, extensible through plugins for greater convenience. Architecturally, however, this is an absurdly superficial reduction: beneath the note editor lies, at the very least, a fully fledged framework for single-page applications. A persistent key-value store whose changes are immediately reflected in the user interface through a reactive dependency graph, using a powerful query/filter language to populate highly expressive template structures with aggregated data—an instrument whose potential, in the opinion of literally every more reflective user, remains utterly unexplored by its established uses. What is particularly interesting is that, over the years, its paradoxical status of *universally acknowledged underappreciation* has not faded in the slightest: TW5 continues to tower inexorably above every attempt to find an application worthy of its conceptual depth.

Clerus was created to finally pull this sword from the stone—I have the audacity to claim an organic *continuation* of TiddlyWiki’s vision in a direction that unlocks its true potential. At present, TW5’s expressive power and architectural grace serve a reactive approach to “capturing, organizing and sharing complex information”: an active operator works with passive tiddlers, and additional code is written essentially only to make those tiddlers look better, easier to edit, or easier to find. Forgive me, colleagues, but we live in the age of agents—the ecological niche of purely reactive tools increasingly resembles a mass grave. Fortunately, TiddlyWiki outgrew it long ago and is receiving its well-deserved promotion to the league of proactive systems for working with complex information.

# Phase 0: Persistent Actor Runtime

The architecture of Clerus should be understood through its two primary premises:

> At any given moment, all authoritative information about the system’s state is stored exclusively in tiddlers.

> Administrative information is not materialized in tiddlers unless explicitly necessary.

The central architectural principle is that derived information belongs to a perspective, not to the object from which it is derived. Tiddlers contain only non-derivable knowledge, while subscription management, liveness computation, invariant auditing, exception handling, and other administrative processes take place ephemerally within dispatcher closures. Authoritative fields change only as a result of a legal operation commit (see below), or a dedicated system transition explicitly belonging to the lifecycle of a materialized object.

## Introduction

Clerus’s proactivity entails a deliberate departure from the principle that “every change to tiddlers records, directly or indirectly, some operator action,” extending it with “or a state transition of an active system element.” The emergence of several independent event sources competing for access to data creates a need for an unambiguous conflict-resolution mechanism. This is provided by the basic principle of “one reads and writes, everyone else only reads,” applied at the granularity of individual tiddlers. The right to overwrite each tiddler is determined by the authoritative `clerus-custody` field, which designates its *responsible custodian* (also called its *home platform*):

- `clerus-custody: user` (or an absent field)—the tiddler’s responsible custodian is the user, who modifies it reactively through conventional widgets;
- `clerus-custody: browser`—the tiddler’s responsible custodian is the browser-side Clerus runtime;
- `clerus-custody: node`—the tiddler’s responsible custodian is the Clerus runtime in the host process of a local installation.

In local TW5 installations, the system is effectively bicameral: the browser and host runtimes are autonomous, loosely coupled, and perceive each other as active elements of the external environment, on a par with the user. Existing tiddlers can be voluntarily transferred between custodians; nonexistent tiddlers are considered unowned and are assigned to the platform that creates them.

## Projects and Tasks

From this point onward, the central metaphor is *virtual office administration*. Treating vanilla TW5 as a catalogued archive of arbitrary documents, we supplement it with a universal model of organizational structure that uses this archive for its administrative needs, under the user’s direction. The main interface between the human and the wiki office consists of **projects**: a special type of JSON tiddler that specifies, in detail, an arbitrary ongoing activity managed by the Clerus runtime.

In Clerus, projects encapsulate purposeful activity organized through *structural decomposition*. A tree of subtasks is serialized into the tiddler body in the most obvious way: each node is a record of the form `{ "task": any, "parts": { ... } }`, where the `task` field contains the *configuration* of a particular task in a format understood by its executor, and the nested `parts` record consists of named subtrees of the same form. A task’s unique identifier within a project is its *role*: the sequence of names leading from the root to the addressed subtree.

Projects can operate either in the user’s custody or assigned to one of the platforms. A typical lifecycle pattern is for the operator to create the project root in the conventional reactive interface, then transfer it to the runtime of the appropriate platform, where the subtask tree grows under Clerus’s management. When circumstances arise that the automation did not anticipate, or a phase requiring human attention is reached, control of the project can be returned to the user for manual repair or dissolution.

## Executors and Positions

Task *executors* are extension modules of the special type `module-type: clerus-executor`, whose behavior is determined by interpreting the `task` fields of the projects to which they are assigned. This behavior is expressed exclusively through strictly synchronous functions that react to events dispatched to their area of responsibility. Executors have no stored state of their own, so their workspaces are encapsulated in separate administrative entities called *positions*. At any given moment, no more than one position can be assigned to a task in a project; there is no corresponding restriction in the other direction—a position can participate in several projects, performing multiple roles in each.

Each position is serialized in its own JSON tiddler within the system title namespace, under one of three prefixes:

- `$:/clerus/jobs/` for persistent positions, whose state is synchronized between platforms and resumed after a restart;
- `$:/temp/clerus/jobs/browser/` for ephemeral positions local to the browser;
- `$:/temp/clerus/jobs/node/` for ephemeral positions local to Node.js.

A persistent position’s responsible custodian can be either `browser` or `node`, whereas ephemeral positions are always assigned to the platform on which their tiddler is visible. An executor is assigned to a position once, when it is created, and remains unchanged until the position is abolished; its identity is stored in the authoritative `clerus-executor` field. The tiddler body—the `text` field—is a record containing the serialized *operational register* of the position (see below). The executor of a persistent position can operate in both the browser and Node.js simultaneously, by defining two separate behavior functions, but only on the home platform can it perform actions that change the position’s register or responsible custodian.

## Documents and Registers

The administrative atoms of Clerus are documents: official records, each attesting to a particular fact significant to the system or the user, and accompanying changes to that fact. A document’s authoritative representation is its JSON serialization, stored in operational and/or transactional registers; duplicate records are considered to be the same document. In the `browser` and `node` runtimes, each document type is represented by its own *instrumental form*: a JS object that mechanizes the dynamics of the circumstances it records. Instrumental forms are declared in special extensions of type `module-type: clerus-document`, which define:

- the class of documents covered by the instrumental form;
- the interface provided to the executor for working with those documents;
- document-circulation rules: whether duplication is permitted, restrictions on transmission in the transactional registers of official messages of particular kinds or to particular recipients, the consequences of destruction, and so on;
- the dispatching of events related to the documented circumstances.

Documents are stored and transferred in *registers*: unordered collections serialized as JSON records, whose keys are assigned and interpreted arbitrarily by executors. Each position contains one *operational* register, and each official message carries one *transactional* register. Executor code never has direct access to documents. Instead, its event handlers are parameterized by *contexts* that mechanize registers, extracting the required document by key and wrapping it in an instance of the appropriate instrumental form. Event contexts give the executor access only to the position’s own registers: one operational register, one incoming transactional register if the event is official, and the transactional registers of outgoing official messages scheduled during that same reaction.

The contents of the operational register fully determine a position’s administrative standing: its responsibilities, the range of authority available for carrying them out, and its participation in the system’s information flow. Message transactional registers are the only means of transferring official documents between positions. No legal executor action can directly modify documents in another position’s operational or transactional registers. However, the behavior of the instrumental forms of its own documents may depend on the contents of other positions’ registers—for example, the assignment-validity mechanism described below.

## Standard Instrumental Forms

- *Position charter* (`{ "form": "charter", "book": ?any, "status": any }`). A mandatory document in every operational register, created and destroyed together with the position. It is produced from an establishment mandate (see below) when a newly created position receives that mandate in the transactional register of its founding order, and cannot be transmitted in messages. The `book` field is carried over from the mandate used and contains arbitrary JSON defining immutable standing instructions in an executor-specific format. In the `status` field, the executor projects its *working status*: publicly relevant information about the position’s state. Orders addressed to the position are dispatched through its charter.
- *Working memos* (`{ "form": "memo", "data": any }`). The simplest documents, storing information of no official significance at the executors’ discretion. They are created through a special charter method, freely duplicated, and transmitted in any message without restriction. They dispatch no events. They are destroyed silently and without side effects.
- *Ordinary tiddler titles* (strings without special prefixes). The position receives notifications when these tiddlers are created, modified, or deleted, and can read them. Titles can be copied and transmitted in transactional registers, but cannot be created from arbitrary strings: new instances can be returned only by methods of objects already available in the context. They are destroyed silently and without side effects.
- *Titles of other positions* (strings identified by their prefixes). The position receives notifications of changes to the working status of positions known to it, and can inspect that status. Knowing a position’s title allows official orders to be sent to it. These titles can be freely copied, like ordinary tiddler titles, but their transmission in transactional registers is restricted by the rules of subordination (see below). A new position title can be created only through a special charter method that appends a specified segment to the position’s own title, separated by `/`. This does not create the position itself, which also requires an establishment mandate. Destroying titles can cause the positions they reference to be removed from project roles, or even abolished altogether.
- *Position establishment mandates* (`{ "form": "contract", "temp": ?boolean, "executor": string, "book": ?any }`). These documents cannot be copied, but can be transmitted in official messages. An order carrying such a mandate in its transactional register may be addressed even to a position title for which no tiddler yet exists. In that case, the position is established, and the mandate becomes its charter. The optional `temp` field can constrain the choice between persistence and ephemerality for the position being created.
- *Project role assignments* (`{ "form": "mission", "project": string, "role": string[], ... }`). The holder of a *valid* assignment can read the task corresponding to its role and is notified when that task changes or is deleted. In addition, the position can send official reports up the project tree and receive them from below. On the project’s home platform, the position can create, read, modify, and delete the immediate subtasks of its task. The position can create a new assignment to an immediate subtask, simultaneously removing any position previously assigned to that role. Assignments cannot be copied, but a position can transfer them in transactional registers, again subject to the rules of subordination. Destroying an assignment is equivalent to withdrawing from the task and deactivates all assignments below it in the project tree. The mechanism for determining assignment validity is described separately below.

A document’s serialization cannot be `null`, a number, `true`/`false`, or an array. Additional instrumental forms can be defined through further `module-type: clerus-document` modules.

## Assignment Validity

Because every project participant must be able not only to assign other positions to its subtasks but also to remove them forcibly, the mere presence of an assignment in an operational register is insufficient to establish an executor’s authority. The validity of an assignment as a document is determined not only by its own contents, but also by an unbroken chain of records confirming its authority in the assignments of higher-level tasks, all the way to the project root. For this purpose, `mission` documents have three additional fields:

- `link`—a generation identity tag that distinguishes assignments issued at different times for the same project role;
- `issued`—a local issuance history that prevents tags from being reused in subordinate assignments;
- `children`—the authoritative selection of immediate child assignments, mapping subtask names to their valid generation tags.

The instrumental form authorizes a position’s participation in a project only if its assignment is reachable from the valid root assignment through a chain of valid tags, with the rules of subordination (see below) observed at every step. Deletion is the only permitted operation on an assignment that has lost validity. Root assignments are considered the user’s responsibility, and their validity is determined by the most “recent” tag, provided it is unique. The model does not protect against obsolete root assignments being reactivated when the valid one is deleted.

## Work Planning

Contexts isolate executors from the internal structure of registers, offering instances of the instrumental forms of the documents they contain instead. The semantics of an instrumental form may depend on the circumstances in which a document is accessed: some forms may provide different functionality on different platforms, and executors that do not hold `clerus-custody` are denied calls to methods that modify the operational register. Most importantly, however, ephemeral and persistent positions receive different levels of reliability guarantees.

When the executor of an ephemeral position handles an event, all side effects of instrumental calls are materialized immediately. An unexpected system shutdown or an uncaught exception can therefore interrupt the process at any point, with no possibility of recovery. For persistent positions, by contrast, the system attempts to preserve transactional integrity in line with the programmer’s expectations: the materialization of side effects is deferred until the reaction function completes successfully. This allows the latest actions of a failing executor to be rolled back in their entirety, and interrupted materializations to be resumed and completed.

A persistent position’s reaction to an event can thus be viewed as a two-phase process. First, the runtime constructs a *work plan*, transparently to the executor. After the reaction function completes successfully, it materializes the requested effects in a batch, eliminating executor failure as a factor. To make this procedure not only abortable on error but also resumable after unexpected shutdowns, work-plan materialization guarantees at-least-once delivery, stable identity, and deduplication for official effects.

When reacting to events on a platform other than the one designated by the position’s `clerus-custody`, the executor is subject to only one additional restriction: it cannot write to its own operational register. If the cumulative effect of the plan does not affect local documents, its materialization does not depend on the responsible custodian. For example, even outside its home platform, an executor is allowed to receive a document in an official report, schedule an operation that changes it, and send the result in an order to another subordinate. The document’s transit through the operational register is ephemeral and does not violate the rules.

## Transactional Flows

Clerus guarantees that the movement and transformation of registers through successive activations of persistent positions, linked by chains of causally related official messages, resume from the interrupted operation after unexpected shutdowns, without information loss. This is achieved by maintaining a write-ahead log for each such *transactional flow*, serialized in a separate JSON tiddler with the prefix `$:/clerus/wal/browser/` or `$:/clerus/wal/node/`, depending on the platform.

Each log begins when the executor of a persistent position successfully completes handling an event that is not already part of a registered transactional flow, producing a nonempty work plan. The runtime saves the work plan in a new tiddler, then materializes its requested side effects. Once this process is complete, it replaces the executed plan in the log with a list of the official messages it sends to other persistent positions. In the system dispatch queue, these messages are marked as belonging to the transactional flow initiated in this way.

When the event dispatcher takes an official message registered in a transactional flow from its queue for execution, the work plan produced by handling it replaces the processed message in the existing log rather than creating a new one. This continues until the flow’s final message is processed without registering any new messages; the now-empty log is automatically deleted. When the system starts after an unexpected shutdown, all messages remaining in the logs are placed back into the dispatch queue. If a work plan already accepted for materialization is found among them, it is restarted from the beginning.

It is important to bear in mind that the measures ensuring transactional integrity for official register operations are fairly heavyweight, so persistent positions should not be used to service high-frequency processes. Ephemeral subordinates should be used to offload this work, as their “transparent” operational context is better suited to it.

## Error Handling

Instrumental-form methods may throw exceptions if a call is illegal for the position’s executor or impossible for other reasons. The position is considered responsible for handling them correctly. The runtime responds differently to uncaught exceptions depending on the type of position and the circumstances of the failure.

An error in the executor of an ephemeral position terminates its authority entirely. Its tiddler is transferred to the user’s custody (`clerus-custody: user`) for dissection, the uncaught exception is saved in its working status, and a special dismissal event is dispatched to the position itself. The position is automatically removed from project participation by revoking all valid assignments, with cascading deactivation of every assignment to their subtasks, so that its superiors can promptly replace the lost subtree. In this state, the position can still react to events, but cannot write to its own tiddler. It should use this ability to wind down its relationships with other positions; further errors are not recorded.

When a persistent position fails on its home platform, the difference from the procedure above resembles the distinction between dismissal and temporary suspension. Transfer of the tiddler to the user’s custody and the working-status update happen in the same way, but participation in projects is preserved. A suspended position should use its limited right to react to events to *hibernate* the subtasks it has entrusted to other positions. If its state can be repaired through conventional reactive tiddler editing, the user can authorize the resumption of its authority by returning `clerus-custody` to its home platform, where it will be notified through a special event.

For errors in persistent positions, the system also attempts to preserve the transactional context: the circumstances of the problem are serialized into the WAL tiddler instead of the work plan. Processing of the transaction’s other branches continues as usual, but when the process is complete, a log containing recorded errors is not deleted. Instead, it too is handed over to the user for dissection.

Since the executor of a persistent position on a platform other than its home platform already lacks permission to overwrite its own tiddler, its errors there are considered nondestructive to its own state. The position is not penalized even with temporary suspension, and the circumstances of the problem are saved only in the transaction log.

## Position Hierarchy

To ensure a number of useful properties, the system maintains three structural invariants:

1. Positions are connected by an *acyclic directed graph of subordination*, where an edge is defined by the presence of a subordinate position’s title in the operational register of its immediate superior. Ordinary tiddlers and other documents are not part of this graph.
2. An ephemeral position cannot be the superior of a persistent one.
3. A position’s assignment to a subtask is authoritative only when the task immediately containing that subtask has an authoritative assignment held either by the same position or by one of its immediate superiors.

Thus, first, the positions engaged in each project form a connected subgraph of the subordination graph, and this subgraph cannot lose connectivity through the unexpected dematerialization of their ephemeral colleagues. Second, the duration of information movement in either direction considered separately—downward, from superiors to subordinates, and upward, from subordinates to superiors—is naturally bounded by the height of the graph. The two kinds of official messages that carry transactional registers between its nodes have already been mentioned in passing; let us now examine them more closely:

- **Orders** are transmitted anonymously from a superior to an immediate subordinate. They are addressed to a position’s title and are not formally tied to a particular project; task-relevant instructions can simply be transmitted in a `memo`. Titles of persistent positions must not be transmitted in the transactional registers of orders addressed to ephemeral positions. Furthermore, a position’s title must not be transmitted either to the position it identifies or to any of that position’s transitive subordinates. An assignment to a subtask may be transmitted in an order only if the assignment to its immediate parent task remains in the operational register.
- **Reports** are transmitted from a subordinate to an immediate superior participating in the same project. They are addressed through a particular valid assignment and signed with the role specified in it. Position titles may be transmitted in report transactional registers without restriction. An assignment may be transmitted in a report only through that assignment itself.

The dispatcher respects this topology: any initial event can trigger a cascade of reactions that propagates first through reports and then, on its return path, through orders. Reports in reactions to orders are forbidden to prevent cycles. Each such causal wave is processed in a single synchronous dispatch pass, including the reactions of activated executors, the registration of plans in the log, and the materialization of requested effects—or the immediate execution of operations for ephemeral positions.

There is no one-to-one correspondence between causal waves and transactional flows. A causal wave that begins and ends in ephemeral positions without visiting persistent ones creates no transactional flows. Each report sent by an ephemeral subordinate to a persistent superior during a single causal wave begins a separate transactional flow. A transactional flow interrupted by an error does not end with the causal wave that originated it, and can later be resumed from the surviving log.

## Garbage Collection

All positions, including persistent ones, are administrative entities: preserving their state does not imply that their existence must be preserved indefinitely. The runtime can automatically abolish positions that are no longer needed, but lack of need does not, by itself, authorize destruction.

**A position’s liveness belongs to the runtime’s current perspective.** It is derived from authoritative documents and outstanding system obligations, rather than stored in additional fields in the position’s tiddler. Liveness analysis does not modify registers, materialize a history of observations, or delete anything by itself.

A position is retained on the following grounds:

- its operational register contains a valid assignment to a project task; temporary unavailability of the task itself does not cancel retention as long as the assignment remains valid;
- its title is present as a document in another position’s operational register;
- it participates in an accepted but not yet completed obligation: for example, as the owner of a plan being materialized, the addressee of a pending message or deferred event, the recipient of an unfinished establishment operation, or a position referenced by a future operational register.

Retention is determined by the semantics of official documents and obligations, not by matching strings. A title written inside a working memo’s data does not thereby become a reference document. Likewise, sender metadata and the history of already processed messages do not retain former participants merely because they preserve their names.

**An accepted obligation preserves its grounds for retention until completion, including when it is transferred to the user’s custody.** Suspending execution is not equivalent to cancellation. As work is completed, the corresponding grounds disappear or are replaced by materialized facts: for example, a future reference in an accepted plan becomes an ordinary document in an operational register. The history of a completed obligation does not, by itself, extend liveness.

This arrangement does not require computing the reachability of all positions from a single set of roots. An existing operational reference document retains the position it identifies regardless of whether its own holder is retained. Consequently, an unneeded organization can be abolished through successive passes: deleting a superior destroys its register and thereby releases its subordinates for subsequent collection. Directorial positions are naturally retained by root assignments, but these are not the only direct grounds for liveness.

Collection follows the principle that **lack of knowledge does not confer authority to destroy**. If an unreadable operational register or unknown WAL semantics prevent the full set of retention grounds from being established, the runtime does not declare positions eligible for deletion. Consistency of the organizational structure is also a prerequisite for collection: automatic deletion is not used as a means of repairing violated invariants.

The absence of retention grounds makes a position only a candidate. To actually abolish it, the runtime must hold its `clerus-custody`, have a correct understanding of its state, and support the destruction protocol for every document it contains. Unfinished establishment and documents with unsupported destruction consequences prevent automatic deletion.

A collection pass considers the candidates identified at its start, but rechecks the current conditions before each deletion. A newly created reference protects a position from deletion, while any loss of analytical completeness stops further collection. Positions released by deletions in the current pass are considered in subsequent passes.

Automatic collection runs at the boundary of a dispatch pass, not inside an executor’s reaction. It must account for work not yet executed, including the current runtime’s ephemeral queues. Persistent obligations are accounted for individually through the WAL; for unrecorded ephemeral work, the dispatcher may temporarily prohibit collection until that work is complete.
