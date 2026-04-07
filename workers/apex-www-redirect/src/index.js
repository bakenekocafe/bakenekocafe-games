/**
 * apex（bakenekocafe.studio）へのリクエストのみ www へ 301。
 * ルートはゾーンの Worker routes で apex のみに限定。
 */
export default {
  fetch(request) {
    var u = new URL(request.url);
    var h = u.hostname;
    if (h === 'bakenekocafe.studio' || h === 'bakenekocafe.studio.') {
      u.hostname = 'www.bakenekocafe.studio';
      return Response.redirect(u.toString(), 301);
    }
    return new Response('Not Found', { status: 404 });
  },
};
