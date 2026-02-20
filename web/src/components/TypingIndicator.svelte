<!--
  TypingIndicator — bouncing dots shown while Aria is "thinking".
-->
<script lang="ts">
  // Component with no props — script needed for type declaration.
</script>

<div class="message-row model-row typing-row">
  <div class="message-content">
    <div class="message-avatar">A</div>
    <div class="message-body">
      <div class="message-sender">Aria</div>
      <div class="typing-dots"><span></span><span></span><span></span></div>
    </div>
  </div>
</div>

<style>
  .typing-row { padding: 16px 0; }
  .message-row { border-bottom: none; }
  .message-content {
    max-width: var(--max-content); margin: 0 auto; padding: 0 24px;
    display: flex; gap: 16px; align-items: flex-start;
  }
  .message-avatar {
    width: 28px; height: 28px; border-radius: 50%;
    background: var(--accent-gold); color: var(--bg-primary);
    display: flex; align-items: center; justify-content: center;
    font-size: 0.75rem; font-weight: 700; flex-shrink: 0; margin-top: 2px;
  }
  .message-body { flex: 1; min-width: 0; }
  .message-sender { font-size: 0.8rem; font-weight: 600; color: var(--accent-gold); margin-bottom: 4px; }
  .typing-dots { display: flex; gap: 5px; padding: 8px 0; }
  .typing-dots span {
    width: 7px; height: 7px; background: var(--accent-gold);
    border-radius: 50%; animation: typing-bounce 1.4s infinite;
  }
  .typing-dots span:nth-child(2) { animation-delay: 0.2s; }
  .typing-dots span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes typing-bounce {
    0%, 60%, 100% { opacity: 0.25; transform: translateY(0); }
    30% { opacity: 1; transform: translateY(-5px); }
  }
</style>
