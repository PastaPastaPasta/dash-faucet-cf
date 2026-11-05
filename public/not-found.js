(() => {
  dashhq.network.canonicalize();
  const bar = document.querySelector('dashhq-bar');
  const query = new URLSearchParams(location.search);
  const network = query.has('network') ? dashhq.network.fromUrl() : bar.getAttribute('network');
  bar.setAttribute('network', network);
  document.querySelector('main a[href="/"]').href = dashhq.network.withNetwork(new URL('/', location.href).href, network);
})();
