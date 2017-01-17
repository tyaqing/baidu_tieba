/**
 * Created by ArH on 2016/12/1.
 */
let db      = require('../model/model');
let kue     = require('kue')
    , queue = kue.createQueue();
let cp      = require('child_process');
let func    = require('./func');

// 全局变量
global.worker       = {
    limit  : 4,// 限制进程个数
    cp_list: [] // 进程列表
};
global.global_stats = {
    tieba: []
}; // 广播出去的队列状态 放入全局 避免重复查询

// kue.app.listen(3000);

module.exports = function (app) {

    //获取单个贴吧
    app.get('/tieba/:kw', function (req, res) {
        let kw = req.params.kw;
        if (!kw) res.send({err: 'kw null'});
        db.Tieba.findOne({kw: `${kw}`}, function (err, docs) {
            if (!docs) {
                res.send({err: null})
            }
            else {
                res.send(docs);
            }
            console.log(docs)
        })
    });

    //获取贴吧列表
    app.get('/tieba', function (req, res) {
        db.Tieba.find({})
            .exec(function (err, docs) {
                docs.reverse();
                res.send(docs);
            });
    });

    //获取帖子列表
    app.get('/p', function (req, res) {
        let limit = req.query.limit || 24;
        let skip  = req.query.skip || 0;
        let kw    = decodeURI(req.query.kw) || '湖南工学院';

        let count;
        console.log(kw);
        db.Post.count({kw: kw}, function (err, _count) {
            count = _count;
            db.Post.find({kw: kw})
                .sort({last_update: 'asc'})
                .skip(parseInt(skip))
                .limit(parseInt(limit))
                .exec(function (err, docs) {
                    res.send({data: docs, count: count});
                })
        })

    });
    //获取单个帖子内容
    app.get('/p/:id', function (req, res) {
        let id = req.params.id;
        if (id == null) {
            res.send({err: 'id null'});
        } else {
            db.Post.findOne({_id: id}, function (err, doc) {
                res.send(doc);
            })

        }
    });
    //获取贴吧下用户列表
    /*
     获取贴吧吧主
     {'tieba_list':{"$elemMatch":{'kw':"麻阳二中",'bazhu':"吧主"}}}
     */
    app.get('/user', function (req, res) {
        let limit = req.query.limit || 24;
        let skip  = req.query.skip || 0;
        let kw    = decodeURI(req.query.kw) || '湖南工学院';
        if (!kw) res.send({err: 'kw is null'});
        let count;
        db.User.count({'tieba_list.kw': kw}, function (err, _count) {
            count = _count;
            db.User.find({'tieba_list.kw': kw},
                {
                    "tieba_list": {$elemMatch: {kw: kw}},
                    "sex"       : 1,
                    "user_age"  : 1,
                    "post_total": 1,
                    "vip_level" : 1,
                    "vip_day"   : 1,
                    "name"      : 1,
                    "portrait"  : 1

                })
                .sort({last_update: 'asc'})
                .skip(parseInt(skip))
                .limit(parseInt(limit))
                .exec(function (err, docs) {
                    res.send({data: docs, count: count});
                })
        });


    });

    //获取单个用户信息 name
    app.get('/user/name/:name', function (req, res) {
        let name = req.params.name;
        if (name == null) {
            res.send({err: 'name null'});
        } else {
            db.User.findOne({'name': name}, function (err, docs) {
                res.send(docs);
            })
        }
    });

    //获取单个用户信息 id
    app.get('/user/id/:id', function (req, res) {
        let id = req.params.id;
        if (id == null) {
            res.send({err: 'id null'});
        } else {
            db.User.findOne({'id': id}, function (err, docs) {
                res.send(docs);
            })
        }
    });

    //获取单个帖子所有内容
    app.get('/get_tieba_content', function (req, res) {
        let pid = req.query.pid;
        db.Post.findOne({_id: pid}, function (err, post) {
            if (err) return console.log(err);
            let kw = post.kw;
            db.Tieba.findOne({kw: kw}, function (err, tieba) {
                if (err) return console.log(err);
                let fid = tieba._id;
                func.get_all_content({pid: pid, fid: fid}, (data) => {
                    //保存更新帖子
                    post.update({$set: {postlist: data.postlist}}, function (err, doc, d) {
                        if (err) return console.log(err);
                        res.send({success: '抓取成功'});
                    });

                });
            });
        });
    });

    //获得贴吧基本信息
    app.post('/tieba', function (req, res) {
        let kw = req.body.kw;
        // 贴吧存的就是小写的
        kw     = kw.toLowerCase();
        if (!kw) {
            res.send({err: 'kw null'});
            return;
        }
        if (req.params.kw != '') {
            func.base_info(kw, function (data) {
                if (data == null) return res.send({error: '找不到该贴吧'});
                db.Tieba.findOneAndUpdate({kw: `${kw}`}, data, function (err, docs) {
                    if (docs == null) db.Tieba.create(data);
                });
                res.send(data);
            });
        } else {
            res.send('{err:"no kw"}');
        }
    });


    // queue 接口

    // 获取贴吧列表
    app.get('/queue/get_tieba_list', function (req, res) {
        let kw = req.query.kw;
        if (!req.query.kw) res.send({err: 'kw null'});
        /*
         首先 查找队列 是否有正在爬取
         删除 数组中对象
         */

        for (let i = 0; i < global.global_stats.tieba.length; i++) {
            if (global.global_stats.tieba[i].kw == kw)  return res.send({warning: '这个贴吧会员正在爬取队列中'});
        }
        // 找不到就创建一个队列记录
        db.Tieba.findOne({kw: kw}, function (err, doc) {
            //循环队列
            let page_sum = doc.page_sum == 0 ? 0 : doc.page_sum / 50;
            for (let i = 0; i <= page_sum; i++) {
                queue.create('get_tieba_list', {
                    url: `http://tieba.baidu.com/f?kw=${encodeURI(kw)}&pn=${i * 50}`,
                    kw : kw,
                    _id: doc._id
                }).save(function (err) {
                    if (err) res.send({err: err});
                });
            }
            // 存进全局函数

            global.global_stats['tieba'].push(doc);
            // console.log(global.global_stats);
            // 完成后会执行解锁队列
            queue.create('get_tieba_list', {
                type: 'complete',
                kw  : kw,
                _id : doc._id
            }).save(function (err, info) {
                if (err) res.send({err: err});
            });
            res.send({success: '创建队列成功'});
        });

    });

    // 获取用户列表
    app.get('/queue/get_member_list', function (req, res) {
        let kw = req.query.kw;
        if (!req.query.kw) res.send({err: 'kw null'});

        kue.Job.rangeByType('get_member_list_complete', 'inactive', 0, -1, 'asc', function (err, jobs) {
            for (let i = 0; i < jobs.length; i++) {
                if (jobs[i].data.kw == kw)  return res.send({warning: '这个贴吧会员正在爬取队列中'});
            }
            // 找不到就创建一个队列记录
            db.Tieba.findOne({kw: kw}, function (err, doc) {
                //循环队列
                func.gbk_encode(kw, function (gbk_kw) {
                    // 循环入队
                    let page_sum = doc.follow_sum < 24 ? 1 : (doc.follow_sum / 24) + 1;
                    for (let i = 1; i <= page_sum; i++) {
                        queue.create('get_member_list', {
                            url  : `http://tieba.baidu.com/bawu2/platform/listMemberInfo?word=${gbk_kw}&pn=${i}`,
                            kw   : kw,
                            _id  : doc._id,
                            tieba: doc
                        }).save(function (err) {
                            if (err) res.send({err: err});
                        });
                    }
                    // 完成后会执行解锁队列
                    queue.create('get_member_list_complete', {
                        kw : kw,
                        _id: doc._id
                    }).save(function (err, info) {
                        if (err) res.send({err: err});
                    });
                    res.send({success: '创建队列成功'});
                });

            });
        });
    });


    // 暂时没有 app.get('/queue/test',provides('content'));
    app.get('/queue/status', function (req, res) {
        kue.Job.rangeByType('get_tieba_list_complete', 'inactive', 0, -1, 'asc', function (err, jobs) {
            let resp = [];
            for (let i = 0; i < jobs.length; i++) {
                resp.unshift({
                    kw: jobs[i].data.kw,
                });
            }
            // console.log(jobs);
            res.send(resp);
        });

    });


    //queue 清除所有队列
    app.get('/queue/clean', function (req, res) {
        kue.Job.rangeByState('inactive', 0, -1, 'asc', function (err, jobs) {
            jobs.forEach(function (job) {
                job.remove(function () {
                    console.log('removed ', job.id);
                });
            });
            kue.Job.rangeByState('active', 0, -1, 'asc', function (err, jobs) {
                jobs.forEach(function (job) {
                    job.remove(function () {
                        console.log('removed ', job.id);
                    });
                });
                global_stats.tieba=[];
                res.send({success: '已清除所有队列'});
            });
        });
    });


    /*
     处理进程
     */
    //运行处理队列子进程
    app.get('/queue/manage', function (req, res) {
        if (req.query.type == 'create_process') {
            if (worker.cp_list.length >= worker.limit) {
                return res.send({warning: `不能创建了,最大限制是${worker.limit}个进程`});
            }
            let cp_item = cp.fork('./server/queue/index.js');
            // 接受子进程消息关闭
            cp_item.on('message',function(message){
                console.log(message);
                global.global_stats.tieba.shift();
            });
            worker.cp_list.push(cp_item);
            return res.send({success: '创建进程成功'});
        } else if (req.query.type == 'delete_process') {
            if (worker.cp_list.length == 0) {
                return res.send({warning: '没有可删除的进程'});
            }
            // 查询是否有任务
            if (global_stats.inactiveCount != 0) {
                return res.send({warning: '当前有任务正在进行,进程不可删除'});
            } else {
                worker.cp_list[0].kill();
                worker.cp_list.pop();
                return res.send({success: '删除进程成功'});
            }
        } else {
            return res.send({error: 'value null'});
        }
    });


};
