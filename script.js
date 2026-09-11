(() => {
  const siteHeader = document.querySelector('.site-header');
  const menuToggle = document.querySelector('.menu-toggle');
  const mainNav = document.querySelector('.main-nav');
  const toast = document.querySelector('.toast');
  let toastTimer;

  const showToast = (message) => {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2600);
  };

  const closeMenu = () => {
    if (!siteHeader || !menuToggle) return;
    siteHeader.classList.remove('nav-open');
    menuToggle.setAttribute('aria-expanded', 'false');
    menuToggle.setAttribute('aria-label', '打开导航');
  };

  menuToggle?.addEventListener('click', () => {
    const isOpen = siteHeader.classList.toggle('nav-open');
    menuToggle.setAttribute('aria-expanded', String(isOpen));
    menuToggle.setAttribute('aria-label', isOpen ? '关闭导航' : '打开导航');
  });

  mainNav?.querySelectorAll('a').forEach((link) => link.addEventListener('click', closeMenu));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenu();
  });
  document.addEventListener('click', (event) => {
    if (!siteHeader?.classList.contains('nav-open')) return;
    if (!siteHeader.contains(event.target)) closeMenu();
  });

  document.querySelectorAll('.copy-link').forEach((button) => {
    button.addEventListener('click', async () => {
      const value = button.dataset.copy;
      try {
        await navigator.clipboard.writeText(value);
        showToast('邀请链接已复制');
      } catch {
        const helper = document.createElement('textarea');
        helper.value = value;
        helper.setAttribute('readonly', '');
        helper.style.position = 'fixed';
        helper.style.opacity = '0';
        document.body.appendChild(helper);
        helper.select();
        document.execCommand('copy');
        helper.remove();
        showToast('邀请链接已复制');
      }
    });
  });

  const modelContent = {
    chat: {
      label: 'CHAT / CONVERSATION',
      title: '让长对话保持在状态里。',
      description: '写作、整理、头脑风暴，模型应该像一张随时能回来的桌子，而不是一次次重新排队。',
      points: ['适合连续多轮的日常对话', '开聊前可快速确认线路状态', '切换设备时保持同一套使用习惯'],
      window: 'chuixue-cloud / chat',
      user: '帮我把这段想法整理成一个清晰的框架',
      result: '正在组织内容',
    },
    code: {
      label: 'CODE / BUILD LOOP',
      title: '把等待，留给编译器。',
      description: '查文档、看 diff、让助手解释报错。连续的小步反馈，才是代码工作流真正需要的速度。',
      points: ['适合文档检索和代码问答', '减少频繁刷新与重复重试', '让编辑器、终端和模型保持同一节奏'],
      window: 'chuixue-cloud / code',
      user: '解释这个函数为什么在空数组时失败',
      result: '正在分析调用链',
    },
    research: {
      label: 'RESEARCH / RETRIEVAL',
      title: '资料检索，也要有连续性。',
      description: '打开资料、交叉验证、整理引用。稳定的访问节奏，能让研究回到内容本身。',
      points: ['适合多页面资料检索', '先看线路再打开重要页面', '把跨设备查资料变成固定流程'],
      window: 'chuixue-cloud / research',
      user: '帮我比较这两份资料的关键差异',
      result: '正在读取来源',
    },
  };

  const label = document.querySelector('[data-model-label]');
  const title = document.querySelector('[data-model-title]');
  const description = document.querySelector('[data-model-description]');
  const points = document.querySelector('[data-model-points]');
  const windowName = document.querySelector('[data-window-name]');
  const promptUser = document.querySelector('.prompt-user');
  const promptAi = document.querySelector('.prompt-ai');

  const renderModel = (key) => {
    const content = modelContent[key];
    if (!content) return;
    label.textContent = content.label;
    title.textContent = content.title;
    description.textContent = content.description;
    windowName.textContent = content.window;
    promptUser.innerHTML = `<span>你</span>${content.user}`;
    promptAi.innerHTML = `<span>模型</span><span class="typing"><b></b><b></b><b></b></span>${content.result}<span class="caret"></span>`;
    points.innerHTML = content.points.map((point) => `<li><span class="check">✓</span>${point}</li>`).join('');
  };

  document.querySelectorAll('.model-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.model-tab').forEach((item) => {
        const active = item === tab;
        item.classList.toggle('is-active', active);
        item.setAttribute('aria-selected', String(active));
      });
      renderModel(tab.dataset.model);
    });
  });

  document.querySelectorAll('a[href^="https://xn--9kqs1lo79d.com/"]').forEach((link) => {
    link.addEventListener('click', () => {
      showToast('正在打开注册页');
    });
  });
})();
