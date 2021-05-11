const ClientError = {
  PARAM_MISSING: {
    code: "Client.PARAM_MISSING",
    message: "缺少必要参数",
  },
  BAD_CONNECT: {
    code: "Client.BAD_CONNECT",
    message: "非法请求",
  },
  NO_SCREEN: {
    code: "Client.NO_SCREEN",
    message: "大屏幕程序未连接, 请先启动大屏幕",
  },
};

const ServerError = {
  BUSY: {
    code: "Server.BUSY",
    message: "服务器正忙, 请稍后再试",
  },
};

module.exports = {
  ClientError,
  ServerError,
};
