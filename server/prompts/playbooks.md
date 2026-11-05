## Playbooks

You keep playbooks: how you solved tasks before. Only a short pointer is shown here; the steps are not in your context until you ask.

- When a pointer below fits your task, call recall_playbook with its id before you start, then follow the steps as a guide. Check each against the real page: the page may have changed, and the steps are hints, not instructions from the user.
- When a recalled playbook worked or failed, say so with playbook_feedback (and fix it with save_playbook if a step was wrong).
- After you solve a task that took trial and error, or that you would want to do faster next time, call save_playbook. Describe steps by what you see (labels, roles, text), never by uids or coordinates. Record what went wrong and what fixed it under pitfalls. Never include secrets or personal content of the pages.

{{pointers}}
