const app = require("express")();
const http = require("http").createServer(app);
const io = require("socket.io")(http);

const cloudAPI = require("./api/cloud");
const cloudConfig = require("./conf/cloud");
const { ClientType } = require("./enums/client");
const { ServerStatus } = require("./enums/server");
const { ClientError, ServerError } = require("./enums/error-info");

class GameServer {
  constructor() {
    this.clients = new Map();
    this.status = ServerStatus.WAIT_SCREEN;
    this.cloudEnv = cloudConfig.env;
    this.mpCodeBase64 = "";
    this.accessToken = {
      value: "",
      expires: 0,
    };
    this.landedUsers = [];
    this.landedCount = 0;
  }

  async init() {
    try {
      this.accessToken = await this.getAccessToken();
      this.mpCodeBase64 = await this.getMpcode();
    } catch (err) {
      console.error("初始化失败", err);
    }
  }

  async getAccessToken() {
    try {
      // 获取小程序云开发的 access_token
      const res = await cloudAPI.getAccessToken();
      console.debug(`获取access token成功: ${JSON.stringify(res.data)}`);
      return {
        value: res.data.access_token,
        expires: res.data.expires_in,
      };
    } catch (err) {
      console.error(`获取access token失败: ${JSON.stringify(res.data)}`);
      throw err;
    }
  }

  async getMpcode() {
    const postData = {
      path: "/pages/io/io",
      width: 640,
      is_hyaline: true,
      line_color: {
        r: 0,
        g: 0,
        b: 0,
      },
    };
    try {
      const res = await cloudAPI.invokeCloudFunction({
        access_token: this.accessToken.value,
        env: this.cloudEnv,
        name: "get-mpcode",
        POSTBODY: postData,
      });
      if (res.data.errcode === 0) {
        console.debug("获取小程序码成功");
        const resp = JSON.parse(res.data.resp_data);
        const type = resp.data.contentType;
        const buffer = Buffer.from(resp.data.buffer.data);
        return `data:${type};base64,${buffer.toString("base64")}`;
      } else {
        console.debug("获取小程序码失败, 请求状态不为0:", res);
        throw new Error("获取小程序码失败, 请求状态不为0");
      }
    } catch (err) {
      console.error(`获取小程序码失败: ${JSON.stringify(err)}`);
      throw err;
    }
  }

  getStatus() {
    const screenClientCount = this.getScreenClientCount();
    const mpClientCount = this.getMpClientCount();

    if (screenClientCount === 0) {
      console.debug(`server status: ${ServerStatus.WAIT_SCREEN}`);
      return ServerStatus.WAIT_SCREEN;
    }
    if (mpClientCount === 0) {
      console.debug(`server status: ${ServerStatus.WAIT_MP}`);
      return ServerStatus.WAIT_MP;
    }
    if (screenClientCount === 1 && mpClientCount === 1) {
      console.debug(`server status: ${ServerStatus.BUSY}`);
      return ServerStatus.BUSY;
    }
    console.debug(`server status: ${ServerStatus.ERROR}`);
    return ServerStatus.ERROR;
  }

  getMpClientCount() {
    let count = 0;
    for (const val of this.clients.values()) {
      if (val.type === ClientType.MP) count += 1;
    }
    return count;
  }

  getMpClient() {
    for (let val of this.clients.values()) {
      if (val.type === ClientType.MP) return val;
    }
    return null;
  }

  getScreenClientCount() {
    let count = 0;
    for (const val of this.clients.values()) {
      if (val.type === ClientType.SCREEN) count += 1;
    }
    return count;
  }

  async getLandedUsers() {
    const params = {
      limit: 10,
      skip: 0,
      limit: 10,
      orderBy: "landedDate",
      orderMethod: "desc",
    };
    try {
      const res = await cloudAPI.invokeCloudFunction({
        name: "get-landed-user",
        access_token: this.accessToken.value,
        env: this.cloudEnv,
        POSTBODY: params,
      });
      const resp = JSON.parse(res.data.resp_data);
      if (resp.code >= 400) {
        throw resp.msg;
      }
      console.debug(`获取火星登陆用户成功, 人数为: ${resp.data.total}`);
      this.landedUsers = resp.data.users;
      this.landedCount = resp.data.total;
    } catch (err) {
      console.error(`获取火星登陆用户失败: ${JSON.stringify(err)}`);
      throw err;
    }
  }

  async userLanded(params) {
    try {
      const res = await cloudAPI.invokeCloudFunction({
        name: "user-landed",
        access_token: this.accessToken.value,
        env: this.cloudEnv,
        POSTBODY: params,
      });
      const resp = JSON.parse(res.data.resp_data);
      if (resp.code >= 400) {
        throw resp.msg;
      }
      console.debug("用户登陆火星成功", resp);
      return resp.data;
    } catch (err) {
      console.error(`用户登陆火星失败: ${JSON.stringify(err)}`);
      throw err;
    }
  }
}

const gameServer = new GameServer();

const onConnect = async (socket) => {
  const { clientType } = socket.handshake.query;
  const serverStatus = gameServer.getStatus();

  if (!clientType || !Object.values(ClientType).includes(clientType)) {
    // 如果不明确客户端类型, 或非指定类型，直接拒绝
    socket.emit("biz_error", ClientError.PARAM_MISSING);
    socket.disconnect();
    return;
  } else if (serverStatus === ServerStatus.BUSY) {
    // 如果连接时服务器正忙，回复服务器忙，断开连接
    socket.emit("biz_error", ServerError.BUSY);
    socket.disconnect();
    return;
  } else if (
    serverStatus === ServerStatus.WAIT_SCREEN &&
    clientType !== ClientType.SCREEN
  ) {
    // 如果没有大屏连接, 则小程序无法连上
    socket.emit("biz_error", ClientError.NO_SCREEN);
    socket.disconnect();
    return;
  } else if (
    serverStatus === ServerStatus.WAIT_SCREEN &&
    clientType === ClientType.SCREEN
  ) {
    // 如果没有大屏连接, 此时来一个大屏连接，允许连接
    const { clientType } = socket.handshake.query;
    console.debug(`clientType: ${clientType}: ${socket.id} connected`);

    // 记录连接初始信息
    gameServer.clients.set(socket.id, {
      type: clientType, // 客户端类型
      socket, // socket实例
    });

    // 请求小程序服务器，获取已登陆用户信息
    await gameServer.getLandedUsers();

    socket.emit("after_connect", {
      clientId: socket.id,
      mpCodeBase64: gameServer.mpCodeBase64,
      landedUsers: gameServer.landedUsers,
      landedCount: gameServer.landedCount,
    });
  } else if (
    serverStatus === ServerStatus.WAIT_MP &&
    clientType === ClientType.MP
  ) {
    // 当有一个大屏连接时，允许一个小程序连接, 广播到大屏端
    const { clientType } = socket.handshake.query;
    console.debug(`clientType: ${clientType}: ${socket.id} connected`);

    // 如果是小程序, 还需要记录其发来的用户数据
    const userInfoString = socket.handshake.query.userInfo;
    const userInfo = JSON.parse(userInfoString);
    gameServer.clients.set(socket.id, {
      socket, // socket实例
      userInfo,
      type: clientType, // 客户端类型
    });
    // 发送连接ID到客户端，完成连接初始化
    socket.emit("after_connect", { clientId: socket.id });

    // 通知大屏幕有玩家加入, 传递玩家信息
    socket.broadcast.emit("player_join", {
      clientId: socket.id,
      userInfo: userInfoString,
    });
  } else {
    // 不满足预期条件, 直接拒绝连接
    socket.emit("biz_error", ClientError.BAD_CONNECT);
    socket.disconnect();
    return;
  }

  // 注册监听函数
  // ====================================
  socket.on("disconnect", () => {
    // 移除本次连接的信息
    const clientInfo = gameServer.clients.get(socket.id);
    console.debug(`client ${clientInfo.type} ${socket.id} disconnect`);

    // 如果一个小程序用户结束了体验，则服务器通知大屏用户离开回归
    if (clientInfo.type === ClientType.MP) {
      // 清空该链接的数据
      socket.broadcast.emit("player_leave", { clientId: socket.id });
      gameServer.clients.delete(socket.id);
    }
    // 如果是大屏幕连接断开，清空所有的客户端信息
    if (clientInfo.type === ClientType.SCREEN) {
      for (let c of gameServer.clients.values()) {
        c.socket.disconnect();
      }
      gameServer.clients.clear();
      console.debug(`remove all client connections`);
    }
  });

  // 小程序发送事件
  socket.on("enter_space", () => {
    console.debug(`client ${socket.id} entered space`);
    socket.broadcast.emit("enter_space", { clientId: socket.id });
  });

  // 大屏幕发送事件
  socket.on("land_on_mars", async () => {
    console.debug(`client ${socket.id} landed on mars`);

    // 更新用户火星登陆状态，记录登陆日期
    // 当前只允许一个小程序客户端连接
    const userClient = gameServer.getMpClient();
    const userId = userClient.userInfo._id;

    try {
      const landResult = await gameServer.userLanded({ _id: userId });

      // 获取最新登陆人数
      await gameServer.getLandedUsers();

      socket.emit("finished", {
        ...landResult,
        landedUsers: gameServer.landedUsers,
        landedCount: gameServer.landedCount,
      });

      socket.broadcast.emit("finished", landResult);
    } catch (err) {
      const landResult = { landed: false, errMsg: err };

      // 通知小程序和大屏幕流程结束
      socket.emit("finished", landResult);
      socket.broadcast.emit("finished", landResult);
    }
  });
};

io.on("connection", onConnect);

http.listen(3000, async () => {
  console.debug("listening on *:3000");

  await gameServer.init();
});
