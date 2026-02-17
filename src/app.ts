export const initApp = async (
  config: Config,
  logger: pino.Logger
): Promise<App> => {
  const app = express();
  app.set('trust proxy', true);

  app.use(
    express.raw({
      limit: '1kb',
      type: (req) => req.headers['content-type'] !== APPLICATION_JSON,
    })
  );

  app.use(
    express.json({
      limit: '50kb',
      type: (req) =>
        req.headers['content-type'] === APPLICATION_JSON &&
        req.url !== LARGE_JSON_PATH,
    })
  );

  app.use((req, res, next) => {
    const start = new Date().getTime();
    const ac = new AbortController();
    req.abortSignal = ac.signal;
    res.on('close', ac.abort.bind(ac));

    const requestId = (req.headers['x-request-id'] as any)?.[0] || randomUUID();
    const l = logger.child({ requestId });

    let bytesRead = 0;
    req.on('data', (chunk: Buffer) => {
      bytesRead += chunk.length;
    });

    let bytesWritten = 0;
    const oldWrite = res.write;
    const oldEnd = res.end;

    res.write = function (chunk: Buffer | string, ...rest: any[]) {
      if (chunk) bytesWritten += (chunk as any).length;
      // @ts-ignore
      return oldWrite.apply(res, [chunk, ...rest]);
    };

    // @ts-ignore
    res.end = function (chunk?: Buffer | string, ...rest: any[]) {
      if (chunk) bytesWritten += (chunk as any).length;
      // @ts-ignore
      return oldEnd.apply(res, [chunk, ...rest]);
    };

    res.on('finish', () => {
      l.info(
        {
          duration: new Date().getTime() - start,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          ua: req.headers['user-agent'],
          ip: getClientIp(req),
          br: bytesRead,
          bw: bytesWritten,
        },
        'Request handled'
      );
    });

    asl.run({ logger: l, requestId }, () => next());
  });

  app.use(helmet());
  app.use(compression());

  // ✅ Put your basic routes here (NOT inside express.json type function)
  app.get("/", (req, res) => {
    res.status(200).send("Backend is running 🚀");
  });

  app.get("/health", (req, res) => {
    res.status(200).json({ status: "ok" });
  });

  // Existing health check endpoint (keep)
  app.get(config.healthCheckEndpoint, (req, res) => {
    res.sendStatus(200);
  });

  app.get('/hi', (req, res) => {
    const s = asl.getStore();
    s?.logger.info('hi');
    res.send('hi');
  });

  app.post(
    '/echo',
    makeValidationMiddleware([ev.body('name').notEmpty()]),
    (req, res) => {
      res.json({ msg: `hi ${req.body.name}` });
    }
  );

  app.post(
    LARGE_JSON_PATH,
    express.json({ limit: '5mb', type: APPLICATION_JSON }),
    (req, res) => {
      // TODO: handle large json payload
      res.end();
    }
  );

  app.get('/abort-signal-propagation', async (req, res) => {
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 25));
      if (req.abortSignal.aborted) throw new Error('aborted');
    }

    const usersRes = await fetch(
      'https://jsonplaceholder.typicode.com/users',
      { signal: req.abortSignal }
    );

    if (usersRes.status !== 200) {
      throw new Error(`unexpected non-200 status code ${usersRes.status}`);
    }

    const users = await usersRes.json();
    res.json(users);
  });

  app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    asl.getStore()?.logger.error(err);
    if (res.headersSent) return;
    res.status(500).json({ msg: 'Something went wrong' });
  });

  return {
    requestListener: app,
    shutdown: async () => {
      // add any cleanup code here including database/redis disconnecting and background job shutdown
    },
  };
};
